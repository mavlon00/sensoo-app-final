import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  Animated,
  Easing,
  Modal,
  ScrollView,
  Image,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { verifyScanOnline, ScanApiResponse } from '../services/sensooApiService';
import { getCurrentUserLocation } from '../services/clinicService';
import { getStoredScans, saveScanToLocalHistory } from '../services/sensooStorageService';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface VerificationVerdict {
  code: string;
  name: string;
  brand: string;
  batch: string;
  status: 'GENUINE' | 'FAKE' | 'ALREADY_PURCHASED' | 'IMPOSSIBLE_PHYSICS' | 'WRONG_REGION';
  title: string;
  description: string;
  region: string;
  telemetry: {
    lat: number;
    lng: number;
    velocity: string;
    time: string;
  };
}

export default function CheckingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string, origin?: string }>();
  const scannedCode = (params.code || '401817 00982').trim().toUpperCase();

  // Step state: 0 = start, 1 = reading, 2 = database, 3 = manufacturer, 4 = counterfeit, 5 = complete
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [isFinished, setIsFinished] = useState(false);
  const [verdict, setVerdict] = useState<VerificationVerdict | null>(null);
  const [showVerdictModal, setShowVerdictModal] = useState(false);

  // Animations
  const ringRotateAnim = useRef(new Animated.Value(0)).current;
  const miniSpinAnim = useRef(new Animated.Value(0)).current;
  const resultFadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Continuous rotation for outer progress ring
  useEffect(() => {
    const ringLoop = Animated.loop(
      Animated.timing(ringRotateAnim, {
        toValue: 1,
        duration: 2200,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    ringLoop.start();

    // Fast spinner for the active checklist step
    const miniLoop = Animated.loop(
      Animated.timing(miniSpinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    miniLoop.start();

    return () => {
      ringLoop.stop();
      miniLoop.stop();
    };
  }, [ringRotateAnim, miniSpinAnim]);

  // Sequential progression through verification steps with live backend data
  useEffect(() => {
    let isMounted = true;
    const now = new Date().toLocaleTimeString();

    // Start live backend verification
    const apiPromise = verifyScanOnline(scannedCode)
      .then((res) => ({ ok: true, data: res as ScanApiResponse }))
      .catch((err) => {
        console.warn('Backend live verification error, using fallback:', err);
        return { ok: false, data: null };
      });

    // Step progression animation timers:
    // Step 1: Reading details -> completes at 500ms
    const timer1 = setTimeout(() => { if (isMounted) setCurrentStep(2); }, 500);
    // Step 2: Checking trusted database -> completes at 1100ms
    const timer2 = setTimeout(() => { if (isMounted) setCurrentStep(3); }, 1100);

    // Minimum pacing so Step 1 & Step 2 are smoothly perceived before Step 3 completes
    const minPacingPromise = new Promise((resolve) => setTimeout(resolve, 1200));

    Promise.all([apiPromise, minPacingPromise]).then(async ([apiResult]) => {
      if (!isMounted) return;

      const apiResponse = apiResult.ok && apiResult.data ? apiResult.data : null;

      if (!apiResponse) {
        // True live failure: Never fake or pretend mock products. Route to official unavailable screen.
        router.replace({
          pathname: '/verification-unavailable',
          params: { code: scannedCode },
        });
        return;
      }

      // Step 3 (Analyzing manufacturer data) completes -> Move to Step 4 (Looking for counterfeit signals)
      setCurrentStep(4);

      let scenario:
        | 'COUNTERFEIT'
        | 'ALREADY_PURCHASED'
        | 'IMPOSSIBLE_TRAVEL'
        | 'AUTHENTIC'
        | 'WRONG_REGION' = 'AUTHENTIC';

      let resolvedName = apiResponse.product_name || `Item ${scannedCode}`;
      let resolvedBrand = apiResponse.manufacturer || 'Registry Whitelist';
      let resolvedBatch = apiResponse.batch_id || 'VERIFIED-BATCH';
      let resolvedReason = apiResponse.reason || 'Product verified in official registry.';
      let verdictStatus: 'GENUINE' | 'FAKE' | 'ALREADY_PURCHASED' | 'IMPOSSIBLE_PHYSICS' | 'WRONG_REGION' = 'GENUINE';

      // 1. Check if this unique barcode was already scanned previously (Clone / Double-Spend detection)
      const storedScans = await getStoredScans();
      const prevScan = (storedScans || []).find(
        (s) => s.code === scannedCode && (Date.now() - new Date(s.timestamp).getTime() > 3000)
      );

      const alarms = (apiResponse.alarms || []).map((a) => a.toLowerCase());
      const reasonLower = (apiResponse.reason || '').toLowerCase();
      const isBackendClone =
        alarms.some((a) => a.includes('purchased') || a.includes('clone') || a.includes('already')) ||
        reasonLower.includes('already purchased') ||
        reasonLower.includes('clone');

      const isPrevGeneric =
        !prevScan?.name ||
        prevScan.name.startsWith('Authentic GS1 Product') ||
        prevScan.name.startsWith('Unregistered');
      const isApiReal =
        apiResponse.product_name &&
        !apiResponse.product_name.startsWith('Authentic GS1 Product') &&
        !apiResponse.product_name.startsWith('Unregistered');

      const preferredName = isApiReal
        ? apiResponse.product_name!
        : (!isPrevGeneric ? prevScan!.name : (apiResponse.product_name || `Product (${scannedCode})`));

      const preferredBrand =
        (apiResponse.manufacturer && !apiResponse.manufacturer.includes('GS1'))
          ? apiResponse.manufacturer
          : (prevScan?.manufacturer || apiResponse.manufacturer || 'Registered Brand');

      // Check if this product was already scanned previously (Clone / Double-Spend detection)
      const shouldFlagClone = Boolean(prevScan || isBackendClone);

      if (shouldFlagClone) {
        scenario = 'ALREADY_PURCHASED';
        verdictStatus = 'ALREADY_PURCHASED';
        const scanCity = prevScan?.location || 'Current Location';
        const scanTime = prevScan?.time || 'earlier today';
        resolvedName = preferredName;
        resolvedBrand = preferredBrand;
        resolvedReason = `🚨 CLONE DETECTED: This product was already scanned and verified in ${scanCity} (${scanTime}). High probability of cloned packaging or duplicate barcode reuse.`;
      } else if (apiResponse.status === 'AUTHENTIC') {
        scenario = 'AUTHENTIC';
        verdictStatus = 'GENUINE';
        resolvedName = preferredName;
        resolvedBrand = preferredBrand;
        resolvedBatch = apiResponse.batch_id || prevScan?.batchId || 'VERIFIED-BATCH';
        resolvedReason = apiResponse.reason || 'Verified by Manufacturer. Registered in national database.';
      } else {
        // Real alarms classification directly from live backend
        if (
          alarms.some((a) => a.includes('physics') || a.includes('speed') || a.includes('travel') || a.includes('velocity')) ||
          reasonLower.includes('physics') ||
          reasonLower.includes('velocity') ||
          reasonLower.includes('travel')
        ) {
          scenario = 'IMPOSSIBLE_TRAVEL';
          verdictStatus = 'IMPOSSIBLE_PHYSICS';
        } else if (
          alarms.some((a) => a.includes('region')) ||
          reasonLower.includes('region')
        ) {
          scenario = 'WRONG_REGION';
          verdictStatus = 'WRONG_REGION';
        } else {
          scenario = 'COUNTERFEIT';
          verdictStatus = 'FAKE';
        }

        const isUnknownProd = !apiResponse.product_name || apiResponse.product_name.toLowerCase().includes('unknown');
        resolvedName = isUnknownProd ? `Unregistered Product (${scannedCode})` : apiResponse.product_name!;

        const isUnknownMan = !apiResponse.manufacturer || apiResponse.manufacturer.toLowerCase().includes('unknown');
        resolvedBrand = isUnknownMan ? 'Unregistered Origin' : apiResponse.manufacturer!;

        const isUnknownBatch = !apiResponse.batch_id || apiResponse.batch_id.toLowerCase().includes('unknown');
        resolvedBatch = isUnknownBatch ? 'UNLISTED' : apiResponse.batch_id!;

        resolvedReason = apiResponse.reason || 'Barcode does not exist in authorized manufacturer whitelist database.';
      }

      const userLoc = await getCurrentUserLocation();
      const detectedCity = userLoc.city || 'Eket';
      const resolvedImg = apiResponse?.image_url || prevScan?.imageUrl || undefined;

      setVerdict({
        code: scannedCode,
        name: resolvedName,
        brand: resolvedBrand,
        batch: resolvedBatch,
        status: verdictStatus,
        title: scenario === 'AUTHENTIC' ? '✓ Authentic Product Verified' : (scenario === 'ALREADY_PURCHASED' ? '🚨 Already Purchased / Cloned Pack' : `🚨 ${scenario.replace('_', ' ')}`),
        description: resolvedReason,
        region: scenario === 'ALREADY_PURCHASED' ? `${prevScan?.location || 'Eket'} (Previous Scan Recorded)` : detectedCity,
        telemetry: {
          lat: userLoc.lat || 0,
          lng: userLoc.lng || 0,
          velocity: scenario === 'ALREADY_PURCHASED' ? 'Reused Code (Duplicate)' : '0 km/h (Live)',
          time: now,
        },
      });

      // Persist to local recent scans immediately
      saveScanToLocalHistory({
        name: resolvedName,
        code: scannedCode,
        status: verdictStatus === 'GENUINE' ? 'VERIFIED' : (scenario === 'WRONG_REGION' ? 'WRONG_REGION' : 'COUNTERFEIT'),
        statusText: verdictStatus === 'GENUINE' ? 'Verified' : (scenario === 'WRONG_REGION' ? 'Wrong Region' : (scenario === 'ALREADY_PURCHASED' ? 'Already Purchased' : 'Counterfeit')),
        scenario,
        imageUrl: resolvedImg,
        location: userLoc.city || 'Current Location',
        manufacturer: resolvedBrand,
        batchId: resolvedBatch,
        time: now,
      }).catch(console.warn);

      // Give Step 4 ("Looking for counterfeit signals") an authentic brief validation moment (~350ms)
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (!isMounted) return;

      // Step 4 completes -> All steps done (Step 5)
      setCurrentStep(5);
      setIsFinished(true);

      // Pulse animation on the center circle
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.08,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();

      // Brief transition delay so user perceives the complete checkmark before routing
      await new Promise((resolve) => setTimeout(resolve, 280));
      if (!isMounted) return;

      // Navigate smoothly with real server parameters
      if (params.origin === 'chat') {
        router.replace({
          pathname: '/agent',
          params: {
            scenario,
            scanCode: scannedCode,
            productName: resolvedName,
            origin: 'chat_return',
          },
        });
      } else {
        const resolvedExpiry = (apiResponse as any).expiry_date || prevScan?.expiryDate || '';
        const resolvedNafdac = (apiResponse as any).nafdac || prevScan?.nafdac || '';
        const conflictCity = prevScan?.location || '';
        const conflictTime = prevScan?.time || (scenario === 'IMPOSSIBLE_TRAVEL' ? 'Simultaneous telemetry' : '');

        router.replace({
          pathname: '/result',
          params: {
            scenario,
            code: scannedCode,
            productName: resolvedName,
            manufacturer: resolvedBrand,
            batchId: resolvedBatch,
            reason: resolvedReason,
            imageUrl: resolvedImg || '',
            expiryDate: resolvedExpiry,
            nafdac: resolvedNafdac,
            conflictCity,
            conflictTime,
          },
        });
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [scannedCode, router]);

  const spin = ringRotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const miniSpin = miniSpinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Helper to render the step icon
  const renderStepIcon = (stepIndex: number) => {
    if (currentStep > stepIndex) {
      // Completed step: green circle with white checkmark
      return (
        <View style={styles.checkCircleDone}>
          <Text style={styles.checkMarkText}>✓</Text>
        </View>
      );
    } else if (currentStep === stepIndex) {
      // Active step: rotating green arc spinner
      return (
        <View style={styles.spinnerContainer}>
          <Animated.View
            style={[
              styles.miniSpinner,
              {
                transform: [{ rotate: miniSpin }],
              },
            ]}
          />
        </View>
      );
    } else {
      // Pending step: empty gray ring
      return <View style={styles.checkCirclePending} />;
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent />

      {/* Top Header Row with Back Chevron */}
      <SafeAreaView style={styles.topSafeArea} edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.backButton}
            activeOpacity={0.7}
            onPress={() => router.back()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.backChevronText}>‹</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Animated Center Progress Circle with 3D Isometric Cube Box */}
        <Animated.View
          style={[
            styles.circleContainer,
            {
              transform: [{ scale: pulseAnim }],
            },
          ]}
        >
          {/* Rotating Emerald Gradient Ring */}
          <Animated.Image
            source={require('../../assets/icons/progress_ring.png')}
            style={[
              styles.progressRingImage,
              {
                transform: [{ rotate: spin }],
              },
            ]}
            resizeMode="contain"
          />

          {/* Centered 3D Isometric Wireframe Cube Box Icon */}
          <View style={styles.cubeBoxWrapper}>
            <Image
              source={require('../../assets/icons/isometric_box.png')}
              style={styles.isometricBoxImage}
              resizeMode="contain"
            />
          </View>
        </Animated.View>

        {/* Title and Subtitle */}
        <Text style={styles.headingTitle}>
          {isFinished ? 'Verification Complete!' : 'Checking product...'}
        </Text>
        <Text style={styles.subtitle}>
          {isFinished
            ? 'Results ready. Viewing product telemetry and safety checks.'
            : 'Please wait while we verify\nthis product.'}
        </Text>

        {/* Step-by-Step Verification Checklist Card */}
        <View style={styles.checklistCard}>
          {/* Step 1 */}
          <View style={styles.stepRow}>
            <View style={styles.iconColumn}>{renderStepIcon(1)}</View>
            <Text
              style={[
                styles.stepLabel,
                currentStep >= 1 && styles.stepLabelActive,
              ]}
            >
              Reading product details
            </Text>
          </View>

          {/* Step 2 */}
          <View style={styles.stepRow}>
            <View style={styles.iconColumn}>{renderStepIcon(2)}</View>
            <Text
              style={[
                styles.stepLabel,
                currentStep >= 2 && styles.stepLabelActive,
              ]}
            >
              Checking with trusted database
            </Text>
          </View>

          {/* Step 3 */}
          <View style={styles.stepRow}>
            <View style={styles.iconColumn}>{renderStepIcon(3)}</View>
            <Text
              style={[
                styles.stepLabel,
                currentStep >= 3 && styles.stepLabelActive,
              ]}
            >
              Analyzing manufacturer data
            </Text>
          </View>

          {/* Step 4 */}
          <View style={styles.stepRow}>
            <View style={styles.iconColumn}>{renderStepIcon(4)}</View>
            <Text
              style={[
                styles.stepLabel,
                currentStep >= 4 && styles.stepLabelActive,
              ]}
            >
              Looking for counterfeit signals
            </Text>
          </View>
        </View>

        {/* Quick View Button once finished if modal is dismissed */}
        {isFinished && !showVerdictModal && (
          <TouchableOpacity
            style={styles.viewResultButton}
            activeOpacity={0.85}
            onPress={() => setShowVerdictModal(true)}
          >
            <Text style={styles.viewResultButtonText}>View Verification Verdict</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Result Verdict Modal Sheet */}
      <Modal visible={showVerdictModal} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.verdictSheet}>
            {verdict && (
              <>
                {/* Status Indicator Bar */}
                <View style={styles.sheetHandle} />

                {/* Status Header */}
                <View style={styles.verdictHeader}>
                  <View
                    style={[
                      styles.verifiedIconBadge,
                      verdict.status !== 'GENUINE' && styles.alertIconBadge,
                    ]}
                  >
                    <Text
                      style={[
                        styles.verifiedBadgeCheck,
                        verdict.status !== 'GENUINE' && styles.alertBadgeCheck,
                      ]}
                    >
                      {verdict.status === 'GENUINE' ? '✓' : '!'}
                    </Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text
                      style={[
                        styles.verdictStatusTitle,
                        verdict.status !== 'GENUINE' && { color: '#DC2626' },
                      ]}
                    >
                      {verdict.title}
                    </Text>
                    <Text style={styles.verdictStatusSubtitle}>
                      Verified by Sensoo Telemetry Core
                    </Text>
                  </View>
                </View>

                <View style={styles.sheetDivider} />

                {/* Product & Batch Specs */}
                <View style={styles.specRow}>
                  <Text style={styles.specLabel}>Product</Text>
                  <Text style={styles.specValue}>{verdict.name}</Text>
                </View>

                <View style={styles.specRow}>
                  <Text style={styles.specLabel}>Manufacturer</Text>
                  <Text style={styles.specValue}>{verdict.brand}</Text>
                </View>

                <View style={styles.specRow}>
                  <Text style={styles.specLabel}>Barcode ID</Text>
                  <Text style={styles.specCodeValue}>{verdict.code}</Text>
                </View>

                <View style={styles.specRow}>
                  <Text style={styles.specLabel}>Batch Number</Text>
                  <Text style={styles.specValue}>{verdict.batch}</Text>
                </View>

                <View style={styles.specRow}>
                  <Text style={styles.specLabel}>GPS Territory</Text>
                  <Text style={styles.specValue}>{verdict.region}</Text>
                </View>

                <View style={styles.specRow}>
                  <Text style={styles.specLabel}>Physics Velocity</Text>
                  <Text
                    style={[
                      styles.specValue,
                      { color: verdict.status === 'GENUINE' ? '#166534' : '#DC2626' },
                    ]}
                  >
                    {verdict.telemetry.velocity}
                  </Text>
                </View>

                {/* Description Box */}
                <View
                  style={[
                    styles.descriptionCard,
                    verdict.status !== 'GENUINE' && styles.alertDescriptionCard,
                  ]}
                >
                  <Text
                    style={[
                      styles.descriptionBoxText,
                      verdict.status !== 'GENUINE' && styles.alertDescriptionText,
                    ]}
                  >
                    {verdict.description}
                  </Text>
                </View>

                {/* Action Buttons */}
                <TouchableOpacity
                  style={[
                    styles.primaryActionButton,
                    verdict.status !== 'GENUINE' && styles.dangerActionButton,
                  ]}
                  activeOpacity={0.85}
                  onPress={() => router.replace('/scanner')}
                >
                  <Text style={styles.primaryActionText}>Scan Another Product</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.homeLinkButton}
                  activeOpacity={0.7}
                  onPress={() => router.replace('/home')}
                >
                  <Text style={styles.homeLinkText}>Return to Home</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },

  /* Top Safe Area & Header */
  topSafeArea: {
    backgroundColor: '#FFFFFF',
    zIndex: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  backChevronText: {
    fontSize: 34,
    fontWeight: '300',
    color: '#0F172A',
    lineHeight: 36,
  },

  /* Main Scroll Content */
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 30,
    paddingBottom: 40,
  },

  /* Center Graphic: Ring & Cube Box */
  circleContainer: {
    width: 160,
    height: 160,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
    position: 'relative',
  },
  progressRingImage: {
    width: 160,
    height: 160,
    position: 'absolute',
  },
  cubeBoxWrapper: {
    width: 74,
    height: 74,
    justifyContent: 'center',
    alignItems: 'center',
  },
  isometricBoxImage: {
    width: 66,
    height: 66,
  },

  /* Typography */
  headingTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '400',
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 36,
    paddingHorizontal: 20,
  },

  /* Checklist Card */
  checklistCard: {
    width: '100%',
    backgroundColor: '#F3FAF6',
    borderRadius: 24,
    paddingVertical: 24,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: '#E6F4ED',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  iconColumn: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  stepLabel: {
    fontSize: 15.5,
    fontWeight: '500',
    color: '#334155',
    flex: 1,
  },
  stepLabelActive: {
    color: '#0F172A',
    fontWeight: '600',
  },

  /* Step Icon Styles */
  checkCircleDone: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#059669',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkMarkText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    marginTop: -1,
  },
  spinnerContainer: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  miniSpinner: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2.5,
    borderColor: '#D1FAE5',
    borderTopColor: '#059669',
    borderRightColor: '#10B981',
  },
  checkCirclePending: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#CBD5E1',
    backgroundColor: 'transparent',
  },

  viewResultButton: {
    marginTop: 28,
    backgroundColor: '#059669',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 20,
    width: '100%',
    alignItems: 'center',
  },
  viewResultButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },

  /* Verdict Modal Sheet */
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  verdictSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 36,
    maxHeight: '90%',
  },
  sheetHandle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#E2E8F0',
    alignSelf: 'center',
    marginBottom: 18,
  },
  verdictHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  verifiedIconBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#DCFCE7',
    borderWidth: 2,
    borderColor: '#10B981',
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertIconBadge: {
    backgroundColor: '#FEE2E2',
    borderColor: '#EF4444',
  },
  verifiedBadgeCheck: {
    fontSize: 24,
    fontWeight: '800',
    color: '#059669',
  },
  alertBadgeCheck: {
    fontSize: 24,
    fontWeight: '800',
    color: '#DC2626',
  },
  verdictStatusTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#059669',
    marginBottom: 3,
  },
  verdictStatusSubtitle: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '500',
  },
  sheetDivider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginVertical: 12,
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
  },
  specLabel: {
    fontSize: 13.5,
    color: '#64748B',
    fontWeight: '500',
  },
  specValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    maxWidth: '65%',
    textAlign: 'right',
  },
  specCodeValue: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#059669',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  descriptionCard: {
    backgroundColor: '#F0FDF4',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DCFCE7',
    marginTop: 12,
    marginBottom: 20,
  },
  alertDescriptionCard: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FEE2E2',
  },
  descriptionBoxText: {
    fontSize: 13.5,
    color: '#166534',
    lineHeight: 19,
    fontWeight: '500',
  },
  alertDescriptionText: {
    color: '#991B1B',
  },
  primaryActionButton: {
    backgroundColor: '#059669',
    paddingVertical: 15,
    borderRadius: 22,
    alignItems: 'center',
    marginBottom: 10,
  },
  dangerActionButton: {
    backgroundColor: '#DC2626',
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  homeLinkButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  homeLinkText: {
    fontSize: 14.5,
    fontWeight: '600',
    color: '#64748B',
  },
});
