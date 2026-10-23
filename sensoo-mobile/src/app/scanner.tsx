import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  Platform,
  Animated,
  Easing,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { setLastCapturedScanFrame, validateGs1Barcode } from '../services/sensooApiService';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const RETICLE_SIZE = Math.min(SCREEN_WIDTH * 0.72, 270);

export default function ScannerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ origin?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [torchOn, setTorchOn] = useState(false);
  const [scanMode, setScanMode] = useState<'barcode' | 'qr'>('barcode');
  const [isScanning, setIsScanning] = useState(true);
  const cameraRef = useRef<CameraView>(null);

  // Automatically request permission on mount if not yet determined
  useEffect(() => {
    if (!permission) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // 2-3 Second "Hold Steady" Stabilization Ring State
  const [stabilizingCode, setStabilizingCode] = useState<string | null>(null);
  const [countdownRemaining, setCountdownRemaining] = useState<number>(2);
  const [isLocked, setIsLocked] = useState(false);

  const lockAnim = useRef(new Animated.Value(0)).current;
  const lockTimerRef = useRef<any>(null);
  const lockTimeoutRef = useRef<any>(null);
  const resetTimerRef = useRef<any>(null);
  const activeCodeRef = useRef<string | null>(null);
  const isLockedRef = useRef(false);
  const frameFrequencyRef = useRef<Map<string, number>>(new Map());

  const STABILIZATION_MS = 2200; // 2.2 seconds hold steady

  const cancelStabilization = useCallback(() => {
    if (isLockedRef.current) return;
    if (lockTimeoutRef.current) clearTimeout(lockTimeoutRef.current);
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    lockAnim.setValue(0);
    activeCodeRef.current = null;
    frameFrequencyRef.current.clear();
    setStabilizingCode(null);
    setCountdownRemaining(2);
  }, [lockAnim]);

  // Reset scanner whenever returning to this screen
  useFocusEffect(
    useCallback(() => {
      setIsScanning(true);
      setIsLocked(false);
      isLockedRef.current = false;
      cancelStabilization();
    }, [cancelStabilization])
  );

  // Animated sweeping laser beam
  const laserAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loopLaser = Animated.loop(
      Animated.sequence([
        Animated.timing(laserAnim, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(laserAnim, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    loopLaser.start();
    return () => loopLaser.stop();
  }, [laserAnim]);

  const translateY = laserAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, RETICLE_SIZE - 6],
  });

  // Navigate to dedicated Checking / Verification screen with real confirmed code
  const navigateToChecking = (codeToVerify: string) => {
    setIsScanning(false);
    setIsLocked(true);
    isLockedRef.current = true;
    if (lockTimeoutRef.current) clearTimeout(lockTimeoutRef.current);
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);

    router.push({
      pathname: '/checking',
      params: { code: codeToVerify, origin: params.origin },
    });
  };

  const startStabilization = (code: string) => {
    if (isLockedRef.current) return;

    // If countdown is already running, consensus tracking in handleBarcodeScanned updates activeCodeRef smoothly
    if (lockTimeoutRef.current) {
      return;
    }

    activeCodeRef.current = code;
    setStabilizingCode(code);
    setCountdownRemaining(2);

    // Silently capture a lightweight snapshot of the product packaging during the 2.2s hold-steady window
    setTimeout(() => {
      try {
        cameraRef.current
          ?.takePictureAsync({
            quality: 0.45,
            base64: true,
            skipProcessing: true,
            shutterSound: false,
          })
          .then((photo) => {
            if (photo?.base64) {
              setLastCapturedScanFrame(activeCodeRef.current || code, photo.base64);
            }
          })
          .catch(() => {});
      } catch {
        // Ignore snapshot errors
      }
    }, 250);

    lockAnim.setValue(0);
    Animated.timing(lockAnim, {
      toValue: 1,
      duration: STABILIZATION_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    // 1-second interval update
    lockTimerRef.current = setTimeout(() => {
      setCountdownRemaining(1);
    }, 1100);

    // Lock-in completion: select absolute consensus winner across all collected frames
    lockTimeoutRef.current = setTimeout(() => {
      setIsLocked(true);
      isLockedRef.current = true;
      setCountdownRemaining(0);

      let consensusWinner = activeCodeRef.current || code;
      let highestCount = 0;
      for (const [candidate, count] of frameFrequencyRef.current.entries()) {
        if (count > highestCount) {
          highestCount = count;
          consensusWinner = candidate;
        }
      }

      setTimeout(() => {
        navigateToChecking(consensusWinner);
      }, 350);
    }, STABILIZATION_MS);
  };

  const handleBarcodeScanned = (result: { data: string; type: string }) => {
    if (!isScanning || isLockedRef.current) return;
    let clean = (result.data || '').trim();
    if (!clean) return;

    // Preserve leading 0 when camera reads a 0-prefixed 13-digit EAN-13 as a 12-digit code
    if (/^\d{12}$/.test(clean)) {
      clean = `0${clean}`;
    }

    // Checksum Gate: If pure 12-14 digits, reject invalid glare reads immediately
    // Glare-corrupted frames (e.g. 8904035170773 vs 8904035427073) fail check digit and are discarded!
    if (/^\d{12,14}$/.test(clean)) {
      const gs1 = validateGs1Barcode(clean);
      if (!gs1.isValid) {
        return;
      }
    }

    // Postpone decay as long as barcode is actively visible
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }

    resetTimerRef.current = setTimeout(() => {
      cancelStabilization();
    }, 900);

    // Track frame frequency for multi-frame consensus
    const prevCount = frameFrequencyRef.current.get(clean) || 0;
    frameFrequencyRef.current.set(clean, prevCount + 1);

    // Update active code to the highest-confidence majority consensus candidate
    let consensusWinner = clean;
    let highestCount = 0;
    for (const [candidate, count] of frameFrequencyRef.current.entries()) {
      if (count > highestCount) {
        highestCount = count;
        consensusWinner = candidate;
      }
    }

    activeCodeRef.current = consensusWinner;
    setStabilizingCode(consensusWinner);

    startStabilization(consensusWinner);
  };

  const handleRequestPermission = async () => {
    const res = await requestPermission();
    if (!res.granted) {
      Alert.alert(
        'Camera Permission',
        'Camera access was not granted. Please enable camera permissions in your device settings to scan products.'
      );
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" translucent />

      {/* REAL Live Expo Camera Feed */}
      {permission?.granted ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torchOn}
          barcodeScannerSettings={{
            barcodeTypes:
              scanMode === 'barcode'
                ? ['ean13', 'ean8', 'code128', 'itf14']
                : ['qr', 'datamatrix'],
          }}
          onBarcodeScanned={isScanning ? handleBarcodeScanned : undefined}
        />
      ) : (
        <View style={styles.permissionFallback}>
          <View style={styles.permissionIconCircle}>
            <Image
              source={require('../../assets/icons/icon_camera_badge.png')}
              style={styles.permissionCameraIcon}
              resizeMode="contain"
            />
          </View>
          <Text style={styles.permissionTitle}>Camera Access Required</Text>
          <Text style={styles.permissionSubtitle}>
            Sensoo needs camera access to scan barcodes and QR codes for instant product verification.
          </Text>
          <TouchableOpacity
            style={styles.enableCameraButton}
            activeOpacity={0.85}
            onPress={handleRequestPermission}
          >
            <Text style={styles.enableCameraText}>Enable Camera</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Dark Ambient Vignette Overlay */}
      {permission?.granted && <View style={styles.vignetteOverlay} pointerEvents="none" />}

      {/* Top Header Row */}
      <SafeAreaView style={styles.topSafeArea} edges={['top']}>
        <View style={styles.headerRow}>
          {/* Back Arrow */}
          <TouchableOpacity
            style={styles.circleIconButton}
            activeOpacity={0.7}
            onPress={() => router.back()}
          >
            <Text style={styles.backArrowText}>‹</Text>
          </TouchableOpacity>

          <Text style={styles.headerTitleCenter}>Scan Product</Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {/* Help / Scan Failed Tips button */}
            <TouchableOpacity
              style={styles.circleIconButton}
              activeOpacity={0.7}
              onPress={() => router.push('/scan-failed')}
            >
              <Text style={{ fontSize: 16, color: '#FFFFFF', fontWeight: 'bold' }}>?</Text>
            </TouchableOpacity>

            {/* Flashlight Toggle */}
            <TouchableOpacity
              style={[styles.circleIconButton, torchOn && styles.circleIconButtonActive]}
              activeOpacity={0.7}
              onPress={() => setTorchOn(!torchOn)}
            >
              <Text style={styles.torchIconText}>⚡</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {/* Center Scanner Viewfinder with Stabilization Ring */}
      {permission?.granted && (
        <View style={styles.viewfinderCenter} pointerEvents="box-none">
          {/* Top Pill Badge: Status & Countdown */}
          {stabilizingCode ? (
            <Animated.View
              style={[
                styles.stabilizingPill,
                isLocked ? styles.stabilizingPillLocked : styles.stabilizingPillActive,
              ]}
            >
              <Text style={styles.stabilizingPillIcon}>
                {isLocked ? '✓' : '🎯'}
              </Text>
              <Text style={styles.stabilizingPillText}>
                {isLocked
                  ? 'Barcode Confirmed & Locked!'
                  : `Hold Steady... (${countdownRemaining}s)`}
              </Text>
            </Animated.View>
          ) : (
            <View style={styles.idlePillPlaceholder} />
          )}

          {/* Reticle Box */}
          <View style={[styles.reticleBox, stabilizingCode && styles.reticleBoxStabilizing]}>
            {/* 4 Neon Green Corner Brackets */}
            <View style={[styles.cornerBracket, styles.topLeft, stabilizingCode && styles.cornerStabilizing]} />
            <View style={[styles.cornerBracket, styles.topRight, stabilizingCode && styles.cornerStabilizing]} />
            <View style={[styles.cornerBracket, styles.bottomLeft, stabilizingCode && styles.cornerStabilizing]} />
            <View style={[styles.cornerBracket, styles.bottomRight, stabilizingCode && styles.cornerStabilizing]} />

            {/* Glowing Border Pulse when stabilizing */}
            {stabilizingCode && (
              <Animated.View
                style={[
                  styles.stabilizingBorderPulse,
                  {
                    opacity: lockAnim.interpolate({
                      inputRange: [0, 0.5, 1],
                      outputRange: [0.5, 0.85, 1],
                    }),
                  },
                ]}
              />
            )}

            {/* Sweeping Neon Green Laser Beam (only when idle searching) */}
            {isScanning && !stabilizingCode && (
              <Animated.View
                style={[
                  styles.laserBeam,
                  { transform: [{ translateY }] },
                ]}
              >
                <View style={styles.laserLine} />
                <View style={styles.laserGlow} />
              </Animated.View>
            )}

            {/* Stabilization Progress Fill Track at bottom edge of reticle */}
            {stabilizingCode && (
              <View style={styles.progressTrack}>
                <Animated.View
                  style={[
                    styles.progressBarFill,
                    {
                      width: lockAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0%', '100%'],
                      }),
                    },
                  ]}
                />
              </View>
            )}
          </View>

          {/* Bottom Info: Detected Digits & Instant Action Buttons */}
          {stabilizingCode ? (
            <View style={styles.stabilizingBottomBlock}>
              <View style={styles.detectedDigitsBadge}>
                <Text style={styles.detectedDigitsLabel}>DETECTED DIGITS</Text>
                <Text style={styles.detectedDigitsValue}>{stabilizingCode}</Text>
              </View>

              <View style={styles.actionButtonsRow}>
                <TouchableOpacity
                  style={styles.verifyNowBtn}
                  activeOpacity={0.85}
                  onPress={() => navigateToChecking(stabilizingCode)}
                >
                  <Text style={styles.verifyNowText}>⚡ Verify Now</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.cancelBtn}
                  activeOpacity={0.7}
                  onPress={cancelStabilization}
                >
                  <Text style={styles.cancelBtnText}>✕ Reset</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <Text style={styles.reticleHintText}>
              Align {scanMode === 'barcode' ? 'barcode' : 'QR code'} inside the frame
            </Text>
          )}
        </View>
      )}

      {/* Bottom Mode Switcher: Barcode vs QR Code */}
      <SafeAreaView style={styles.bottomSafeArea} edges={['bottom']}>
        <View style={styles.modeSwitcherRow}>
          {/* Barcode Mode */}
          <TouchableOpacity
            style={styles.modeItem}
            activeOpacity={0.8}
            onPress={() => setScanMode('barcode')}
          >
            <View
              style={[
                styles.modeButtonCircle,
                scanMode === 'barcode' ? styles.modeActiveCircle : styles.modeInactiveCircle,
              ]}
            >
              <Text
                style={[
                  styles.modeIconText,
                  scanMode === 'barcode' ? styles.modeActiveIconText : styles.modeInactiveIconText,
                ]}
              >
                |||||
              </Text>
            </View>
            <Text
              style={[
                styles.modeLabel,
                scanMode === 'barcode' ? styles.modeActiveLabel : styles.modeInactiveLabel,
              ]}
            >
              Barcode
            </Text>
          </TouchableOpacity>

          {/* QR Code Mode */}
          <TouchableOpacity
            style={styles.modeItem}
            activeOpacity={0.8}
            onPress={() => setScanMode('qr')}
          >
            <View
              style={[
                styles.modeButtonCircle,
                scanMode === 'qr' ? styles.modeActiveCircle : styles.modeInactiveCircle,
              ]}
            >
              <Text
                style={[
                  styles.modeIconText,
                  scanMode === 'qr' ? styles.modeActiveIconText : styles.modeInactiveIconText,
                ]}
              >
                ▣
              </Text>
            </View>
            <Text
              style={[
                styles.modeLabel,
                scanMode === 'qr' ? styles.modeActiveLabel : styles.modeInactiveLabel,
              ]}
            >
              QR Code
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },

  /* Fallback Permission View */
  permissionFallback: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0A140F',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    zIndex: 10,
  },
  permissionIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#13281E',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  permissionCameraIcon: {
    width: 40,
    height: 40,
  },
  permissionTitle: {
    color: '#FFFFFF',
    fontSize: 21,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 10,
  },
  permissionSubtitle: {
    color: '#9EBAA9',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 28,
  },
  enableCameraButton: {
    backgroundColor: '#10B981',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 24,
  },
  enableCameraText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },

  /* Dark Vignette */
  vignetteOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },

  /* Top Header */
  topSafeArea: {
    zIndex: 20,
    backgroundColor: 'transparent',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 24 : 10,
  },
  circleIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleIconButtonActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.45)',
  },
  backArrowText: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '300',
    lineHeight: 30,
  },
  headerTitleCenter: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  torchIconText: {
    color: '#FFFFFF',
    fontSize: 18,
  },

  /* Viewfinder */
  viewfinderCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleBox: {
    width: RETICLE_SIZE,
    height: RETICLE_SIZE,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerBracket: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderColor: '#10B981',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 10,
    elevation: 8,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 16,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 16,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 16,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 16,
  },

  /* Laser Beam */
  laserBeam: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 3,
    top: 0,
    zIndex: 10,
  },
  laserLine: {
    height: 3,
    backgroundColor: '#10B981',
    borderRadius: 1.5,
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 8,
  },
  laserGlow: {
    height: 14,
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
    marginTop: -8.5,
    borderRadius: 7,
  },
  reticleHintText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 13.5,
    fontWeight: '500',
    marginTop: 22,
  },

  /* Bottom Mode Switcher */
  bottomSafeArea: {
    zIndex: 20,
    backgroundColor: 'transparent',
    paddingBottom: Platform.OS === 'ios' ? 20 : 28,
  },
  modeSwitcherRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
  },
  modeItem: {
    alignItems: 'center',
  },
  modeButtonCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  modeActiveCircle: {
    backgroundColor: '#FFFFFF',
    elevation: 4,
  },
  modeInactiveCircle: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  modeIconText: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
  },
  modeActiveIconText: {
    color: '#0A341E',
  },
  modeInactiveIconText: {
    color: '#FFFFFF',
  },
  modeLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  modeActiveLabel: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  modeInactiveLabel: {
    color: 'rgba(255, 255, 255, 0.65)',
  },

  /* Stabilization UI Elements */
  idlePillPlaceholder: {
    height: 38,
    marginBottom: 14,
  },
  stabilizingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  stabilizingPillActive: {
    backgroundColor: '#0F172A',
    borderWidth: 1.5,
    borderColor: '#10B981',
  },
  stabilizingPillLocked: {
    backgroundColor: '#065F46',
    borderWidth: 1.5,
    borderColor: '#34D399',
  },
  stabilizingPillIcon: {
    fontSize: 16,
    color: '#34D399',
    fontWeight: '700',
  },
  stabilizingPillText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.3,
  },
  reticleBoxStabilizing: {
    shadowColor: '#10B981',
    shadowOpacity: 0.8,
    shadowRadius: 18,
    elevation: 10,
  },
  cornerStabilizing: {
    borderColor: '#34D399',
    shadowColor: '#34D399',
    shadowRadius: 14,
  },
  stabilizingBorderPulse: {
    ...StyleSheet.absoluteFill,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#10B981',
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
  },
  progressTrack: {
    position: 'absolute',
    bottom: -6,
    left: 10,
    right: 10,
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#10B981',
    borderRadius: 3,
  },
  stabilizingBottomBlock: {
    marginTop: 18,
    alignItems: 'center',
    gap: 12,
  },
  detectedDigitsBadge: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  detectedDigitsLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1,
    marginBottom: 2,
  },
  detectedDigitsValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#34D399',
    letterSpacing: 1.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  verifyNowBtn: {
    backgroundColor: '#10B981',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    shadowColor: '#10B981',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 4,
  },
  verifyNowText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  cancelBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  cancelBtnText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
  },
});
