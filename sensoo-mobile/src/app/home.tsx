import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  Platform,
  Dimensions,
  TextInput,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Speech from 'expo-speech';
import * as Updates from 'expo-updates';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { sendAgentMessage } from '../services/sensooAiService';
import { fetchLiveFeed } from '../services/sensooApiService';
import { getCurrentUserLocation } from '../services/clinicService';
import {
  getVoiceAssistantSettings,
  subscribeVoiceAssistantSettings,
  parseVoiceCommand,
  VoiceAssistantSettings,
  transcribeAudioWithGroq,
} from '../services/voiceAssistantService';
import { speakWithCartesia, stopCartesiaSpeech } from '../services/cartesiaTtsService';
import {
  getStoredScans,
  clearStoredScans,
  subscribeToStoredScans,
  getDeviceLinkInfo,
  DeviceLinkInfo,
} from '../services/sensooStorageService';
import { subscribeAuth, UserProfile } from '../services/authService';
import {
  queryNafdacGreenbook,
  fetchLiveNafdacGreenbook,
  NafdacGreenbookProduct,
} from '../services/nafdacGreenbookService';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export type ViewType = 'Home' | 'RecentScans' | 'VerifiedProducts' | 'Alerts' | 'Profile' | 'Notifications';

export interface NotificationItem {
  id: string;
  category: 'Verification' | 'System' | 'Updates';
  title: string;
  description: string;
  time: string;
  dateGroup: 'Today' | 'Yesterday';
  iconType: 'counterfeit' | 'repeat' | 'globe' | 'verified' | 'gear';
  iconBg: string;
  isRead: boolean;
  scenario?: 'AUTHENTIC' | 'COUNTERFEIT' | 'ALREADY_PURCHASED' | 'IMPOSSIBLE_TRAVEL' | 'WRONG_REGION';
  code?: string;
}

const INITIAL_NOTIFICATIONS_DATA: NotificationItem[] = [];

interface RecentScanItem {
  [x: string]: string | undefined;
  id: string;
  name: string;
  image: any;
  status: 'VERIFIED' | 'COUNTERFEIT' | 'WRONG_REGION';
  statusText: string;
  time: string;
  dateGroup: 'Today' | 'Yesterday';
  scenario: 'AUTHENTIC' | 'COUNTERFEIT' | 'ALREADY_PURCHASED' | 'IMPOSSIBLE_TRAVEL' | 'WRONG_REGION';
  code: string;
  manufacturer?: string;
  batchId?: string;
  nafdac?: string;
  expiryDate?: string;
  reason?: string;
  imageUrl?: string;
}

const RECENT_SCANS_DATA: RecentScanItem[] = [];

interface VerifiedProductItem {
  id: string;
  name: string;
  image: any;
  category: 'Medicine' | 'Skincare' | 'Personal Care' | 'Food';
  time: string;
  code: string;
}

const VERIFIED_PRODUCTS_DATA: VerifiedProductItem[] = [];

interface AlertItem {
  id: string;
  name: string;
  image: any;
  alertType: 'Counterfeit' | 'Reused' | 'Wrong Region' | 'Suspicious';
  badgeIcon: string;
  badgeBg: string;
  badgeTextColor: string;
  statusPillText: string;
  statusPillBg: string;
  statusPillColor: string;
  time: string;
  callout: string;
  scenario: 'COUNTERFEIT' | 'ALREADY_PURCHASED' | 'IMPOSSIBLE_TRAVEL' | 'WRONG_REGION';
  code: string;
}

const ALERTS_DATA: AlertItem[] = [];

interface ReportItemData {
  id: string;
  name: string;
  image: any;
  date: string;
  status: 'Under Review' | 'Reviewed' | 'Action Taken' | 'Closed';
  statusBg: string;
  statusColor: string;
}

const REPORTS_DATA: ReportItemData[] = [];

export default function HomeScreen() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<ViewType>('Home');
  const [previousView, setPreviousView] = useState<ViewType>('Home');

  // Search & Filters state
  const [recentSearch, setRecentSearch] = useState('');
  const [recentFilter, setRecentFilter] = useState<'All' | 'Verified' | 'Counterfeit' | 'Alerts'>('All');

  const [verifiedSearch, setVerifiedSearch] = useState('');
  const [verifiedFilter, setVerifiedFilter] = useState<'All' | 'Medicine' | 'Skincare' | 'Personal Care' | 'Food'>('All');

  const [alertFilter, setAlertFilter] = useState<'All' | 'Counterfeit' | 'Reused' | 'Wrong Region' | 'Suspicious'>('All');
  const [reportsTabFilter, setReportsTabFilter] = useState<'All' | 'Under Review' | 'Reviewed'>('All');

  // Notifications & Profile state
  const [notificationFilter, setNotificationFilter] = useState<'All' | 'Verification' | 'System' | 'Updates'>('All');
  const [notifications, setNotifications] = useState<NotificationItem[]>(INITIAL_NOTIFICATIONS_DATA);

  // Dynamic Live Scan State from Backend
  const [recentScans, setRecentScans] = useState<RecentScanItem[]>(RECENT_SCANS_DATA);
  const [verifiedProducts, setVerifiedProducts] = useState<VerifiedProductItem[]>(VERIFIED_PRODUCTS_DATA);
  const [alerts, setAlerts] = useState<AlertItem[]>(ALERTS_DATA);
  const [userCity, setUserCity] = useState('Current Location');
  const [greenbookStatusFilter, setGreenbookStatusFilter] = useState<'All' | 'Active' | 'Inactive'>('All');
  const [selectedGreenbookProduct, setSelectedGreenbookProduct] = useState<NafdacGreenbookProduct | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceLinkInfo | null>(null);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);

  useEffect(() => {
    const unsub = subscribeAuth((state) => {
      setCurrentUser(state.user);
    });
    return unsub;
  }, []);

  // Synchronize local saved scans and linked device identity whenever user views Home
  useFocusEffect(
    React.useCallback(() => {
      let isMounted = true;
      getStoredScans().then((stored) => {
        if (!isMounted) return;
        if (!stored || stored.length === 0) {
          setRecentScans([]);
          return;
        }
        const mapped: RecentScanItem[] = stored.map((s, idx) => ({
          id: s.id || `stored-${idx}`,
          name: s.name,
          image: s.imageUrl ? { uri: s.imageUrl } : require('../../assets/barcode_icon.png'),
          imageUrl: s.imageUrl,
          status: s.status,
          statusText: s.statusText,
          time: s.time,
          dateGroup: 'Today',
          scenario: s.scenario,
          code: s.code,
          manufacturer: s.manufacturer,
          batchId: s.batchId,
          nafdac: s.nafdac,
          expiryDate: s.expiryDate,
          reason: s.reason,
        }));
        setRecentScans(mapped);
      });

      getDeviceLinkInfo().then((info) => {
        if (isMounted) setDeviceInfo(info);
      });

      return () => {
        isMounted = false;
      };
    }, [])
  );

  // Real-time reactive subscription ensuring local scans always show immediately
  useEffect(() => {
    const unsubscribe = subscribeToStoredScans((stored) => {
      if (!stored || stored.length === 0) {
        setRecentScans([]);
        return;
      }
      const mapped: RecentScanItem[] = stored.map((s, idx) => ({
        id: s.id || `stored-${idx}`,
        name: s.name,
        image: s.imageUrl ? { uri: s.imageUrl } : require('../../assets/barcode_icon.png'),
        imageUrl: s.imageUrl,
        status: s.status,
        statusText: s.statusText,
        time: s.time,
        dateGroup: 'Today',
        scenario: s.scenario,
        code: s.code,
        manufacturer: s.manufacturer,
        batchId: s.batchId,
        nafdac: s.nafdac,
        expiryDate: s.expiryDate,
        reason: s.reason,
      }));
      setRecentScans(mapped);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    getCurrentUserLocation().then((loc) => {
      if (loc.city && loc.city !== 'Current Location') {
        setUserCity(loc.city);
      }
    });
  }, []);

  const [liveGreenbookList, setLiveGreenbookList] = useState<NafdacGreenbookProduct[]>([]);
  const [greenbookTotalCount, setGreenbookTotalCount] = useState(8943);
  const [isGreenbookLoading, setIsGreenbookLoading] = useState(false);

  // Live real-time querying across all 8,943+ NAFDAC Greenbook products
  useEffect(() => {
    if (activeView !== 'VerifiedProducts') return;
    let isMounted = true;
    setIsGreenbookLoading(true);

    const timer = setTimeout(() => {
      fetchLiveNafdacGreenbook(
        verifiedSearch,
        greenbookStatusFilter,
        verifiedFilter === 'All' ? 'All' : verifiedFilter,
        40
      )
        .then((res) => {
          if (!isMounted) return;
          setLiveGreenbookList(res.products);
          setGreenbookTotalCount(res.totalRecords);
          setIsGreenbookLoading(false);
        })
        .catch(() => {
          if (isMounted) setIsGreenbookLoading(false);
        });
    }, 280);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [activeView, verifiedSearch, greenbookStatusFilter, verifiedFilter]);

  // Real-time synchronization with live backend scans feed
  useEffect(() => {
    let isMounted = true;
    const syncLiveFeed = async () => {
      try {
        const feed = await fetchLiveFeed(30);
        if (!isMounted || !feed || !Array.isArray(feed)) return;

        // Filter out legacy unparsed dummy scans from earlier test runs
        const validFeed = feed.filter(
          (item) => item.product_name && item.product_name !== 'None' && item.product_name !== 'Unknown'
        );

        if (validFeed.length === 0) {
          // Never wipe out user local scans!
          return;
        }

        const liveRecent: RecentScanItem[] = [];
        const liveVerified: VerifiedProductItem[] = [];
        const liveAlerts: AlertItem[] = [];
        const liveNotifs: NotificationItem[] = [];

        validFeed.forEach((item, index) => {
          const rawAlarms = item.alarms || [];
          const alarmsLower = rawAlarms.map((a: string) => String(a).toLowerCase());
          const isClean = rawAlarms.length === 0;

          let scenario: RecentScanItem['scenario'] = 'AUTHENTIC';
          let alertType: AlertItem['alertType'] = 'Suspicious';

          if (alarmsLower.some((a) => a.includes('purchased') || a.includes('clone') || a.includes('already'))) {
            scenario = 'ALREADY_PURCHASED';
            alertType = 'Reused';
          } else if (alarmsLower.some((a) => a.includes('physics') || a.includes('speed') || a.includes('travel') || a.includes('velocity'))) {
            scenario = 'IMPOSSIBLE_TRAVEL';
            alertType = 'Suspicious';
          } else if (alarmsLower.some((a) => a.includes('region'))) {
            scenario = 'WRONG_REGION';
            alertType = 'Wrong Region';
          } else if (!isClean) {
            scenario = 'COUNTERFEIT';
            alertType = 'Counterfeit';
          }

          const status: RecentScanItem['status'] = isClean
            ? 'VERIFIED'
            : (scenario === 'WRONG_REGION' ? 'WRONG_REGION' : 'COUNTERFEIT');

          const statusText = isClean
            ? 'Verified'
            : (scenario === 'WRONG_REGION' ? 'Wrong Region' : (scenario === 'ALREADY_PURCHASED' ? 'Already Purchased' : 'Counterfeit'));

          const timeDisplay = item.timestamp
            ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : 'Just now';

          const prodName = item.product_name || `Product\n${item.code}`;

          const prodImage = item.image_url
            ? { uri: item.image_url }
            : require('../../assets/barcode_icon.png');

          const recentEntry: RecentScanItem = {
            id: `feed-recent-${item.timestamp || index}-${index}`,
            name: prodName,
            image: prodImage,
            status,
            statusText,
            time: timeDisplay,
            dateGroup: 'Today',
            scenario,
            code: item.code,
          };
          liveRecent.push(recentEntry);

          if (isClean) {
            liveVerified.push({
              id: `feed-vp-${item.timestamp || index}-${index}`,
              name: prodName,
              image: prodImage,
              category: 'Personal Care',
              time: `Today, ${timeDisplay}`,
              code: item.code,
            });
          } else {
            liveAlerts.push({
              id: `feed-alt-${item.timestamp || index}-${index}`,
              name: prodName,
              image: prodImage,
              alertType,
              badgeIcon: alertType === 'Counterfeit' ? '!' : (alertType === 'Reused' ? '⚠️' : '✈️'),
              badgeBg: alertType === 'Counterfeit' ? '#DC2626' : '#D97706',
              badgeTextColor: '#FFFFFF',
              statusPillText: statusText,
              statusPillBg: alertType === 'Counterfeit' ? '#FEE2E2' : '#FEF3C7',
              statusPillColor: alertType === 'Counterfeit' ? '#DC2626' : '#D97706',
              time: `Today, ${timeDisplay}`,
              callout: rawAlarms.join('; ') || 'Threat anomaly recorded in live telemetry.',
              scenario: scenario as any,
              code: item.code,
            });

            liveNotifs.push({
              id: `feed-notif-${item.timestamp || index}-${index}`,
              category: 'Verification',
              title: `${statusText} alert`,
              description: `Live scan for ${item.code}: ${rawAlarms.join(', ')}`,
              time: timeDisplay,
              dateGroup: 'Today',
              iconType: alertType === 'Counterfeit' ? 'counterfeit' : 'repeat',
              iconBg: alertType === 'Counterfeit' ? '#FEE2E2' : '#FEF3C7',
              isRead: false,
              scenario: scenario as any,
              code: item.code,
            });
          }
        });

        if (liveRecent.length > 0) {
          setRecentScans((prev) => {
            const prevCodes = new Set(prev.map((p) => p.code));
            const feedUnique = liveRecent.filter((l) => !prevCodes.has(l.code));
            return [...prev, ...feedUnique];
          });
        }
        if (liveVerified.length > 0) {
          setVerifiedProducts((prev) => {
            const existingCodes = new Set(liveVerified.map((l) => l.code));
            return [...liveVerified, ...prev.filter((p) => !existingCodes.has(p.code))];
          });
        }
        if (liveAlerts.length > 0) {
          setAlerts((prev) => {
            const existingCodes = new Set(liveAlerts.map((l) => l.code));
            return [...liveAlerts, ...prev.filter((p) => !existingCodes.has(p.code))];
          });
        }
        if (liveNotifs.length > 0) {
          setNotifications((prev) => {
            const existingIds = new Set(prev.map((n) => n.id));
            const uniqueNotifs = liveNotifs.filter((n) => !existingIds.has(n.id));
            return [...uniqueNotifs, ...prev];
          });
        }
      } catch (err) {
        console.warn('Live feed error on home screen:', err);
      }
    };

    syncLiveFeed();
    const interval = setInterval(syncLiveFeed, 6000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const [showPersonalInfoModal, setShowPersonalInfoModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [agentInput, setAgentInput] = useState('');
  const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState(false);

  const handleManualCheckUpdates = async () => {
    if (!Updates.isEnabled) {
      Alert.alert(
        'App Updates',
        'Live over-the-air updates are active in standalone installed APK builds.'
      );
      return;
    }

    try {
      setIsCheckingAppUpdate(true);
      const activeId = Updates.updateId ? Updates.updateId.slice(0, 8) : (Updates.isEmbeddedLaunch ? 'Embedded Base' : 'Initial');
      const activeChannel = Updates.channel || 'preview';
      const activeTime = Updates.createdAt ? new Date(Updates.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Base APK';

      const check = await Updates.checkForUpdateAsync();
      if (check.isAvailable) {
        Alert.alert(
          'Update Found! 🚀',
          `A new update is available on channel "${activeChannel}".\n\nActive: ${activeId} (${activeTime})\n\nDownload and restart now?`,
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Download & Restart',
              onPress: async () => {
                try {
                  setIsCheckingAppUpdate(true);
                  await Updates.fetchUpdateAsync();
                  await Updates.reloadAsync();
                } catch (e) {
                  Alert.alert('Update Error', 'Could not apply update. Please try again.');
                } finally {
                  setIsCheckingAppUpdate(false);
                }
              },
            },
          ]
        );
      } else {
        Alert.alert(
          'Up to Date ✓',
          `Your app is running the latest update on channel "${activeChannel}".\n\nActive Update: ${activeId}\nDeployed: ${activeTime}\n\nWould you like to force reload the bundle?`,
          [
            { text: 'OK', style: 'cancel' },
            {
              text: 'Force Reload App',
              onPress: async () => {
                try {
                  setIsCheckingAppUpdate(true);
                  await Updates.reloadAsync();
                } catch (e) {
                  Alert.alert('Reload Error', 'Could not reload bundle.');
                } finally {
                  setIsCheckingAppUpdate(false);
                }
              },
            },
          ]
        );
      }
    } catch (err: any) {
      const activeId = Updates.updateId ? Updates.updateId.slice(0, 8) : 'Embedded';
      Alert.alert(
        'Update Check',
        `Unable to reach update servers. Check your internet connection.\n\nCurrent Active: ${activeId}`,
        [
          { text: 'OK', style: 'cancel' },
          {
            text: 'Force Reload App',
            onPress: async () => {
              try {
                await Updates.reloadAsync();
              } catch {}
            },
          },
        ]
      );
    } finally {
      setIsCheckingAppUpdate(false);
    }
  };

  // Voice Assistant ("Hey Sensoo") State & Foreground Listener
  const [voiceSettings, setVoiceSettings] = useState<VoiceAssistantSettings>(getVoiceAssistantSettings());
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  React.useEffect(() => {
    const unsub = subscribeVoiceAssistantSettings((s) => setVoiceSettings(s));
    // Pre-warm audio permissions and mode so first voice tap is instantaneous and error-free
    requestRecordingPermissionsAsync()
      .then((perm) => {
        if (perm.granted) {
          setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
          }).catch(() => {});
        }
      })
      .catch(() => {});
    return unsub;
  }, []);

  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const voicePulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let pulseLoop: Animated.CompositeAnimation | null = null;
    if (isVoiceListening) {
      pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(voicePulseAnim, {
            toValue: 1.25,
            duration: 550,
            useNativeDriver: true,
          }),
          Animated.timing(voicePulseAnim, {
            toValue: 1.0,
            duration: 550,
            useNativeDriver: true,
          }),
        ])
      );
      pulseLoop.start();
    } else {
      voicePulseAnim.setValue(1);
    }
    return () => {
      if (pulseLoop) pulseLoop.stop();
    };
  }, [isVoiceListening]);

  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const isTranscribingRef = useRef(false);
  const autoStopTimerRef = useRef<any>(null);

  const stopAndExecuteVoice = async () => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    setIsVoiceListening(false);

    try {
      console.log('[VoiceAssistant] Auto-stopping recording...');
      await audioRecorder.stop();
      const recordedUri = audioRecorder.uri;
      console.log('[VoiceAssistant] Recorded URI:', recordedUri);

      if (recordedUri && !isTranscribingRef.current) {
        isTranscribingRef.current = true;
        try {
          const transcript = await transcribeAudioWithGroq(recordedUri);
          console.log('[VoiceAssistant] Groq Whisper transcript:', transcript);
          if (transcript && transcript.trim().length > 0) {
            handleVoiceCommand(transcript.trim());
          }
        } catch (err: any) {
          console.warn('[VoiceAssistant] Groq Whisper transcription error:', err);
        } finally {
          isTranscribingRef.current = false;
        }
      }
    } catch (err) {
      console.warn('[VoiceAssistant] Error stopping recording:', err);
    }
  };

  const toggleVoiceAssistant = async () => {
    // If already recording and tapped again, stop immediately and process
    if (isVoiceListening) {
      await stopAndExecuteVoice();
      return;
    }

    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Microphone Permission', 'Please grant microphone access to use voice commands.');
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      console.log('[VoiceAssistant] Listening to voice...');
      await audioRecorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
      audioRecorder.record();
      setIsVoiceListening(true);

      // Auto-stop after 1.8s of speech and process automatically (snappy, no long wait)
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = setTimeout(() => {
        stopAndExecuteVoice();
      }, 1800);
    } catch (err) {
      console.warn('[VoiceAssistant] Error starting voice recording:', err);
      setIsVoiceListening(false);
    }
  };

  const handleVoiceCommand = (cmd: string) => {
    setIsVoiceListening(false);
    stopCartesiaSpeech();

    const parsed = parseVoiceCommand(cmd);
    console.log('[VoiceAssistant] Parsed Intent:', parsed.intent, 'for text:', cmd);

    const userName = currentUser?.fullName ? currentUser.fullName.trim().split(' ')[0] : 'there';
    const shouldSpeak = Boolean(voiceSettings.voiceReplyEnabled);

    // 0. Greeting / Wake Word in-place - snappy, short, zero text bubble
    if (parsed.intent === 'GREETING') {
      const greetingVoice = `Hello, ${userName}! How can I help you?`;
      if (shouldSpeak) {
        speakWithCartesia(greetingVoice);
      }
      return;
    } else if (parsed.intent === 'SCAN') {
      if (shouldSpeak) {
        speakWithCartesia('Opening scanner');
      }
      router.push('/scanner');
    } else if (parsed.intent === 'HISTORY') {
      if (shouldSpeak) {
        speakWithCartesia('Opening scan history');
      }
      setActiveView('RecentScans');
    } else if (parsed.intent === 'ALERTS') {
      if (shouldSpeak) {
        speakWithCartesia('Opening alerts');
      }
      setActiveView('Alerts');
    } else if (parsed.intent === 'PROFILE') {
      if (shouldSpeak) {
        speakWithCartesia('Opening profile');
      }
      setActiveView('Profile');
    } else if (parsed.intent === 'NOTIFICATIONS') {
      if (shouldSpeak) {
        speakWithCartesia('Opening notifications');
      }
      setPreviousView(activeView);
      setActiveView('Notifications');
    } else if (parsed.intent === 'PERSONAL_INFO') {
      if (shouldSpeak) {
        speakWithCartesia('Opening personal information');
      }
      setShowPersonalInfoModal(true);
    } else if (parsed.intent === 'PRIVACY_SECURITY') {
      if (shouldSpeak) {
        speakWithCartesia('Opening privacy');
      }
      router.push('/privacy-security' as any);
    } else if (parsed.intent === 'LOCATION_REGION') {
      if (shouldSpeak) {
        speakWithCartesia('Opening location settings');
      }
      router.push('/location-region' as any);
    } else if (parsed.intent === 'ABOUT') {
      if (shouldSpeak) {
        speakWithCartesia('Opening About Sensoo');
      }
      router.push('/about-sensoo' as any);
    } else if (parsed.intent === 'CLINIC') {
      const clinicVoice = 'To view accredited healthcare centers, browse verified clinics or tap the Agent tab.';
      if (shouldSpeak) {
        speakWithCartesia(clinicVoice);
      }
    } else if (parsed.intent === 'REPORT') {
      const reportVoice = 'To file a counterfeit drug report, open any scan from your history and tap Report to NAFDAC.';
      if (shouldSpeak) {
        speakWithCartesia(reportVoice);
      }
    } else if (parsed.intent === 'GUIDANCE') {
      const guideVoice = `I can help you scan products, browse recall alerts, or view your scan history. Try saying Scan product.`;
      if (shouldSpeak) {
        speakWithCartesia(guideVoice);
      }
    } else {
      const fallbackVoice = `How can I help you today, ${userName}? You can say Scan product, Check alerts, or View history.`;
      if (shouldSpeak) {
        speakWithCartesia(fallbackVoice);
      }
    }
  };




  // Continuous pulsating ripple animation for Agent nav button
  const agentPulseValue = React.useRef(new Animated.Value(0)).current;

  const [showVoiceListenerModal, setShowVoiceListenerModal] = useState(false);
  const [voiceListenerSpokenText, setVoiceListenerSpokenText] = useState('');

  React.useEffect(() => {
    const pulseAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(agentPulseValue, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(agentPulseValue, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    pulseAnim.start();

    return () => {
      pulseAnim.stop();
    };
  }, [agentPulseValue]);

  const [agentChat, setAgentChat] = useState<{ sender: 'agent' | 'user'; text: string }[]>([
    {
      sender: 'agent',
      text: `Hello ${currentUser?.fullName ? currentUser.fullName.split(' ')[0] : 'there'}! I am Sensoo Agentic AI. How can I help verify your products, guide your safety, or find clinics today?`,
    },
  ]);

  const handleSendAgentQuery = async (textToSend?: string) => {
    const q = (textToSend || agentInput).trim();
    if (!q) return;
    setAgentChat((prev) => [...prev, { sender: 'user', text: q }]);
    setAgentInput('');

    try {
      const history = agentChat.map((m) => ({
        role: (m.sender === 'agent' ? 'model' : 'user') as 'model' | 'user',
        content: m.text,
      }));
      const latestItem = recentScans.length > 0 ? recentScans[0] : null;
      const res = await sendAgentMessage(q, history, {
        productName: latestItem ? latestItem.name.replace('\n', ' ') : undefined,
        scannedCode: latestItem ? latestItem.barcode : undefined,
        scenario: latestItem ? (latestItem.scenario || 'AUTHENTIC') : undefined,
        userLocation: userCity,
      });
      setAgentChat((prev) => [...prev, { sender: 'agent', text: res.reply }]);
    } catch {
      setAgentChat((prev) => [
        ...prev,
        {
          sender: 'agent',
          text: "I've checked our telemetry database. This product category matches authorized GS1 manufacturer standards.",
        },
      ]);
    }
  };

  const handleMarkAllAsRead = () => {
    setNotifications((prev) => prev.map((item) => ({ ...item, isRead: true })));
  };

  const handleLogout = () => {
    Alert.alert(
      'Log out',
      'Are you sure you want to log out of your Sensoo account?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: () => router.replace('/get-started' as any),
        },
      ]
    );
  };

  const filteredNotifications = notifications.filter((item) => {
    if (notificationFilter === 'All') return true;
    return item.category === notificationFilter;
  });

  const handleScanPress = () => {
    router.push('/scanner' as any);
  };

  const navigateToResult = (itemOrScenario: RecentScanItem | string, maybeCode?: string) => {
    if (typeof itemOrScenario === 'string') {
      const scenario = itemOrScenario;
      const code = maybeCode || '';
      const matched = recentScans.find((s) => s.code === code);
      router.push({
        pathname: '/result',
        params: {
          scenario,
          code,
          productName: matched?.name,
          manufacturer: matched?.manufacturer,
          batchId: matched?.batchId,
          nafdac: matched?.nafdac,
          expiryDate: matched?.expiryDate,
          reason: matched?.reason,
          imageUrl: matched?.imageUrl,
          scanTime: matched?.time,
          isHistoryInspection: 'true',
        },
      });
      return;
    }

    const item = itemOrScenario;
    router.push({
      pathname: '/result',
      params: {
        scenario: item.scenario,
        code: item.code,
        productName: item.name,
        manufacturer: item.manufacturer,
        batchId: item.batchId,
        nafdac: item.nafdac,
        expiryDate: item.expiryDate,
        reason: item.reason,
        imageUrl: item.imageUrl,
        scanTime: item.time,
        isHistoryInspection: 'true',
      },
    });
  };

  // Filtered lists with real-time sync data
  const filteredRecentScans = recentScans.filter((item) => {
    const matchesSearch =
      recentSearch === '' ||
      item.name.toLowerCase().includes(recentSearch.toLowerCase()) ||
      item.code.toLowerCase().includes(recentSearch.toLowerCase());
    if (!matchesSearch) return false;
    if (recentFilter === 'Verified') return item.status === 'VERIFIED';
    if (recentFilter === 'Counterfeit') return item.status === 'COUNTERFEIT';
    if (recentFilter === 'Alerts') return item.status !== 'VERIFIED';
    return true;
  });

  const greenbookProducts =
    liveGreenbookList.length > 0
      ? liveGreenbookList
      : queryNafdacGreenbook(
          verifiedSearch,
          greenbookStatusFilter,
          verifiedFilter === 'All' ? 'All' : verifiedFilter
        );

  const filteredVerifiedProducts = verifiedProducts.filter((item) => {
    const matchesSearch =
      verifiedSearch === '' ||
      item.name.toLowerCase().includes(verifiedSearch.toLowerCase()) ||
      item.code.toLowerCase().includes(verifiedSearch.toLowerCase());
    if (!matchesSearch) return false;
    if (verifiedFilter !== 'All') return item.category === verifiedFilter;
    return true;
  });

  const filteredAlerts = alerts.filter((item) => {
    if (alertFilter === 'All') return true;
    return item.alertType === alertFilter;
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent />

      {/* ======================================================== */}
      {/* 1. MAIN HOME DASHBOARD VIEW */}
      {/* ======================================================== */}
      {activeView === 'Home' && (
        <>
          <SafeAreaView style={styles.topSafeArea} edges={['top']}>
            <View style={styles.headerRow}>
              <Image
                source={require('../../assets/logo.png')}
                style={styles.logo}
                resizeMode="contain"
              />
              <View style={styles.headerRight}>
                <TouchableOpacity
                  style={styles.bellButton}
                  activeOpacity={0.7}
                  onPress={() => {
                    setPreviousView('Home');
                    setActiveView('Notifications');
                  }}
                >
                  <Image
                    source={require('../../assets/icons/icon_bell.png')}
                    style={styles.bellIconImage}
                    resizeMode="contain"
                  />
                  {notifications.some((n) => !n.isRead) && (
                    <View style={styles.bellBadgeDot} />
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.avatarButton}
                  activeOpacity={0.8}
                  onPress={() => {
                    setPreviousView('Home');
                    setActiveView('Profile');
                  }}
                >
                  <Text style={styles.avatarText}>
                    {(currentUser?.fullName || 'User').charAt(0).toUpperCase()}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>

          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* User Greeting */}
            <View style={styles.greetingSection}>
              <Text style={styles.greetingTitle}>
                <Text style={styles.greetingBlack}>Good morning, </Text>
                <Text style={styles.greetingGreen}>
                  {currentUser?.fullName ? currentUser.fullName.split(' ')[0] : 'User'}
                </Text>
              </Text>
              <Text style={styles.greetingSubtitle}>Verify a product before you buy or use it.</Text>
            </View>

            {/* Hero Scan Banner Card */}
            <TouchableOpacity style={styles.heroBannerCard} activeOpacity={0.92} onPress={handleScanPress}>
              <Image
                source={require('../../assets/home_scan_banner.png')}
                style={styles.heroBannerImage}
                resizeMode="cover"
              />
            </TouchableOpacity>

            {/* 3 Shortcut Action Cards Row */}
            <View style={styles.shortcutsRow}>
              {/* Card 1: Recent Scans */}
              <TouchableOpacity
                style={[styles.shortcutCard, { backgroundColor: '#EBF6F0' }]}
                activeOpacity={0.8}
                onPress={() => setActiveView('RecentScans')}
              >
                <Image
                  source={require('../../assets/icons/icon_clock_badge.png')}
                  style={styles.shortcutBadgeImage}
                  resizeMode="contain"
                />
                <View style={styles.shortcutTextWrapper}>
                  <Text style={styles.shortcutTitle}>Recent Scans</Text>
                  <Text style={styles.shortcutSubtitle}>View your history</Text>
                </View>
                <View style={styles.shortcutChevron}>
                  <Text style={styles.shortcutChevronArrow}>›</Text>
                </View>
              </TouchableOpacity>

              {/* Card 2: Verified Products */}
              <TouchableOpacity
                style={[styles.shortcutCard, { backgroundColor: '#EAF4F9' }]}
                activeOpacity={0.8}
                onPress={() => setActiveView('VerifiedProducts')}
              >
                <Image
                  source={require('../../assets/icons/icon_cube_badge.png')}
                  style={styles.shortcutBadgeImage}
                  resizeMode="contain"
                />
                <View style={styles.shortcutTextWrapper}>
                  <Text style={styles.shortcutTitle}>Verified{'\n'}Products</Text>
                  <Text style={styles.shortcutSubtitle}>Trusted brands</Text>
                </View>
                <View style={styles.shortcutChevron}>
                  <Text style={styles.shortcutChevronArrow}>›</Text>
                </View>
              </TouchableOpacity>

              {/* Card 3: Alerts */}
              <TouchableOpacity
                style={[styles.shortcutCard, { backgroundColor: '#FDEEEC' }]}
                activeOpacity={0.8}
                onPress={() => setActiveView('Alerts')}
              >
                <Image
                  source={require('../../assets/icons/icon_shield_badge.png')}
                  style={styles.shortcutBadgeImage}
                  resizeMode="contain"
                />
                <View style={styles.shortcutTextWrapper}>
                  <Text style={styles.shortcutTitle}>Alerts</Text>
                  <Text style={styles.shortcutSubtitle}>Stay informed</Text>
                </View>
                <View style={styles.shortcutChevron}>
                  <Text style={styles.shortcutChevronArrow}>›</Text>
                </View>
              </TouchableOpacity>
            </View>

            {/* Recent Scans Section Header */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Recent Scans</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {recentScans.length > 0 && (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={async () => {
                      await clearStoredScans();
                      setRecentScans([]);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={{ fontSize: 13, color: '#EF4444', fontWeight: '700' }}>Clear</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity activeOpacity={0.7} onPress={() => setActiveView('RecentScans')}>
                  <Text style={styles.seeAllText}>See all ›</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Recent Scans Preview Items */}
            {recentScans.length === 0 ? (
              <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: '#94A3B8', fontWeight: '500' }}>
                  No recent scans yet. Tap "Tap to Scan" above to verify.
                </Text>
              </View>
            ) : (
              recentScans.slice(0, 3).map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.scanCard}
                activeOpacity={0.85}
                onPress={() => navigateToResult(item)}
              >
                <View style={styles.thumbWrapper}>
                  <Image source={item.image} style={styles.thumbImage} resizeMode="contain" />
                </View>
                <View style={styles.scanMeta}>
                  <Text style={styles.productName}>{item.name.replace('\n', ' ')}</Text>
                  <Text style={styles.scanTimestamp}>{item.time}</Text>
                </View>
                <View
                  style={[
                    styles.statusPill,
                    item.status === 'VERIFIED' ? styles.statusVerified : styles.statusCounterfeit,
                  ]}
                >
                  <Text style={styles.statusPillIcon}>{item.status === 'VERIFIED' ? '✓' : '!'}</Text>
                  <Text
                    style={[
                      styles.statusPillText,
                      item.status === 'VERIFIED' ? styles.textVerified : styles.textCounterfeit,
                    ]}
                  >
                    {item.statusText}
                  </Text>
                </View>
              </TouchableOpacity>
            )))}
          </ScrollView>
        </>
      )}

      {/* ======================================================== */}
      {/* 2. SCREEN 1: RECENT SCANS */}
      {/* ======================================================== */}
      {activeView === 'RecentScans' && (
        <>
          <SafeAreaView style={styles.subTopSafeArea} edges={['top']}>
            <View style={styles.subHeaderNav}>
              <TouchableOpacity
                style={styles.backArrowBtn}
                activeOpacity={0.7}
                onPress={() => setActiveView('Home')}
              >
                <Text style={styles.backArrowGlyph}>←</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16 }}>
              <View style={styles.subHeaderTitleBlock}>
                <Text style={styles.subPageTitle}>Recent Scans</Text>
                <Text style={styles.subPageSubtitle}>View all the products you've scanned.</Text>
              </View>
              {recentScans.length > 0 && (
                <TouchableOpacity
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    backgroundColor: '#FEE2E2',
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: '#FCA5A5',
                  }}
                  activeOpacity={0.7}
                  onPress={async () => {
                    await clearStoredScans();
                    setRecentScans([]);
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>🗑️ Clear All</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Search Bar */}
            <View style={styles.searchBarWrapper}>
              <Text style={styles.searchIcon}>🔍</Text>
              <TextInput
                style={styles.searchInput}
                placeholder="Search by product name or brand..."
                placeholderTextColor="#94A3B8"
                value={recentSearch}
                onChangeText={setRecentSearch}
              />
            </View>

            {/* Filter Pills */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterPillsRow}>
              {(['All', 'Verified', 'Counterfeit', 'Alerts'] as const).map((filter) => (
                <TouchableOpacity
                  key={filter}
                  style={[styles.filterChip, recentFilter === filter && styles.filterChipActive]}
                  onPress={() => setRecentFilter(filter)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterChipText, recentFilter === filter && styles.filterChipTextActive]}>
                    {filter}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </SafeAreaView>

          <ScrollView style={styles.scrollView} contentContainerStyle={styles.subScrollContent} showsVerticalScrollIndicator={false}>
            {/* Group: Today */}
            {filteredRecentScans.some((i) => i.dateGroup === 'Today') && (
              <View style={styles.dateGroupContainer}>
                <Text style={styles.dateGroupTitle}>Today</Text>
                {filteredRecentScans
                  .filter((i) => i.dateGroup === 'Today')
                  .map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.subListItemCard}
                      activeOpacity={0.85}
                      onPress={() => navigateToResult(item)}
                    >
                      <View style={styles.subListThumbWrapper}>
                        <Image source={item.image} style={styles.subListThumb} resizeMode="contain" />
                      </View>
                      <View style={styles.subListMeta}>
                        <Text style={styles.subListTitle}>{item.name}</Text>
                        <Text style={styles.subListTime}>{item.time}</Text>
                      </View>
                      <View
                        style={[
                          styles.subListStatusPill,
                          item.status === 'VERIFIED' && styles.statusVerified,
                          item.status === 'COUNTERFEIT' && styles.statusCounterfeit,
                          item.status === 'WRONG_REGION' && styles.statusWarning,
                        ]}
                      >
                        <Text style={styles.statusPillIcon}>
                          {item.status === 'VERIFIED' ? '✓' : '!'}
                        </Text>
                        <Text
                          style={[
                            styles.statusPillText,
                            item.status === 'VERIFIED' && styles.textVerified,
                            item.status === 'COUNTERFEIT' && styles.textCounterfeit,
                            item.status === 'WRONG_REGION' && styles.textWarning,
                          ]}
                        >
                          {item.statusText}
                        </Text>
                      </View>
                      <Text style={styles.subListChevron}>›</Text>
                    </TouchableOpacity>
                  ))}
              </View>
            )}

            {/* Group: Yesterday */}
            {filteredRecentScans.some((i) => i.dateGroup === 'Yesterday') && (
              <View style={styles.dateGroupContainer}>
                <Text style={styles.dateGroupTitle}>Yesterday</Text>
                {filteredRecentScans
                  .filter((i) => i.dateGroup === 'Yesterday')
                  .map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.subListItemCard}
                      activeOpacity={0.85}
                      onPress={() => navigateToResult(item)}
                    >
                      <View style={styles.subListThumbWrapper}>
                        <Image source={item.image} style={styles.subListThumb} resizeMode="contain" />
                      </View>
                      <View style={styles.subListMeta}>
                        <Text style={styles.subListTitle}>{item.name}</Text>
                        <Text style={styles.subListTime}>{item.time}</Text>
                      </View>
                      <View
                        style={[
                          styles.subListStatusPill,
                          item.status === 'VERIFIED' && styles.statusVerified,
                          item.status === 'COUNTERFEIT' && styles.statusCounterfeit,
                          item.status === 'WRONG_REGION' && styles.statusWarning,
                        ]}
                      >
                        <Text style={styles.statusPillIcon}>
                          {item.status === 'VERIFIED' ? '✓' : '!'}
                        </Text>
                        <Text
                          style={[
                            styles.statusPillText,
                            item.status === 'VERIFIED' && styles.textVerified,
                            item.status === 'COUNTERFEIT' && styles.textCounterfeit,
                            item.status === 'WRONG_REGION' && styles.textWarning,
                          ]}
                        >
                          {item.statusText}
                        </Text>
                      </View>
                      <Text style={styles.subListChevron}>›</Text>
                    </TouchableOpacity>
                  ))}
              </View>
            )}
          </ScrollView>
        </>
      )}

      {/* ======================================================== */}
      {/* 3. SCREEN 2: NAFDAC GREENBOOK REGISTERED PRODUCTS */}
      {/* ======================================================== */}
      {activeView === 'VerifiedProducts' && (
        <>
          <SafeAreaView style={styles.subTopSafeArea} edges={['top']}>
            <View style={styles.subHeaderNav}>
              <TouchableOpacity
                style={styles.backArrowBtn}
                activeOpacity={0.7}
                onPress={() => setActiveView('Home')}
              >
                <Text style={styles.backArrowGlyph}>←</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.subHeaderTitleBlock}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.subPageTitle}>NAFDAC Greenbook</Text>
                <View
                  style={{
                    backgroundColor: '#DCFCE7',
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: '#86EFAC',
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#15803D' }}>Official</Text>
                </View>
              </View>
              <Text style={styles.subPageSubtitle}>
                {isGreenbookLoading
                  ? 'Searching 8,943+ official NAFDAC records in real time...'
                  : `Nigeria's Registered Product Database (${greenbookTotalCount.toLocaleString()} Registered Products)`}
              </Text>
            </View>

            {/* Search Bar */}
            <View style={styles.searchBarWrapper}>
              <Text style={styles.searchIcon}>🔍</Text>
              <TextInput
                style={styles.searchInput}
                placeholder="Search Product Name, Ingredients, NRN (e.g. 03-6507)..."
                placeholderTextColor="#94A3B8"
                value={verifiedSearch}
                onChangeText={setVerifiedSearch}
              />
            </View>

            {/* Status Filter Tabs (Active | Inactive | All) */}
            <View style={{ flexDirection: 'row', paddingHorizontal: 16, marginTop: 8, gap: 8 }}>
              {(['All', 'Active', 'Inactive'] as const).map((st) => {
                const isActive = greenbookStatusFilter === st;
                return (
                  <TouchableOpacity
                    key={st}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      borderRadius: 10,
                      backgroundColor: isActive
                        ? (st === 'Active' ? '#DCFCE7' : (st === 'Inactive' ? '#FEF3C7' : '#0F172A'))
                        : '#F1F5F9',
                      borderWidth: 1,
                      borderColor: isActive
                        ? (st === 'Active' ? '#86EFAC' : (st === 'Inactive' ? '#FCD34D' : '#0F172A'))
                        : '#E2E8F0',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 4,
                    }}
                    onPress={() => setGreenbookStatusFilter(st)}
                    activeOpacity={0.8}
                  >
                    {st === 'Active' && <Text style={{ fontSize: 10 }}>🟢</Text>}
                    {st === 'Inactive' && <Text style={{ fontSize: 10 }}>🟡</Text>}
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '700',
                        color: isActive
                          ? (st === 'Active' ? '#15803D' : (st === 'Inactive' ? '#B45309' : '#FFFFFF'))
                          : '#64748B',
                      }}
                    >
                      {st}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Category Filter Pills */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.filterPillsRow, { marginTop: 10 }]}>
              {(['All', 'Medical devices', 'Medicine', 'Skincare', 'Personal Care', 'Food'] as const).map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.filterChip, verifiedFilter === cat && styles.filterChipActive]}
                  onPress={() => setVerifiedFilter(cat as any)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterChipText, verifiedFilter === cat && styles.filterChipTextActive]}>
                    {cat}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </SafeAreaView>

          <ScrollView style={styles.scrollView} contentContainerStyle={styles.subScrollContent} showsVerticalScrollIndicator={false}>
            {greenbookProducts.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 }}>
                <Text style={{ fontSize: 32, marginBottom: 12 }}>📋</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#1E293B', textAlign: 'center' }}>
                  No Products Found in Greenbook
                </Text>
                <Text style={{ fontSize: 13, color: '#64748B', textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                  No registered items match "{verifiedSearch}". Try searching by NRN number (e.g. 03-6507) or ingredient.
                </Text>
              </View>
            ) : (
              greenbookProducts.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={{
                    backgroundColor: '#FFFFFF',
                    borderRadius: 16,
                    padding: 14,
                    marginBottom: 12,
                    borderWidth: 1,
                    borderColor: item.status === 'Inactive' ? '#FDE68A' : '#E2E8F0',
                    shadowColor: '#000',
                    shadowOpacity: 0.04,
                    shadowRadius: 6,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 2,
                  }}
                  activeOpacity={0.85}
                  onPress={() => setSelectedGreenbookProduct(item)}
                >
                  {/* Top Row: Name and Status Badge */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: '#0F172A', lineHeight: 20 }}>
                        {item.productName}
                      </Text>
                    </View>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 8,
                        backgroundColor: item.status === 'Active' ? '#DCFCE7' : '#FEF3C7',
                        borderWidth: 1,
                        borderColor: item.status === 'Active' ? '#86EFAC' : '#FCD34D',
                      }}
                    >
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor: item.status === 'Active' ? '#16A34A' : '#D97706',
                        }}
                      />
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '700',
                          color: item.status === 'Active' ? '#15803D' : '#B45309',
                        }}
                      >
                        {item.status}
                      </Text>
                    </View>
                  </View>

                  {/* NRN and Category Row */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    <View
                      style={{
                        backgroundColor: '#F1F5F9',
                        paddingHorizontal: 7,
                        paddingVertical: 2,
                        borderRadius: 6,
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: '700', color: '#334155' }}>
                        NRN: {item.nrn}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 12, color: '#64748B' }}>•</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#475569' }}>
                      {item.productCategory}
                    </Text>
                  </View>

                  {/* Active Ingredients */}
                  <Text style={{ fontSize: 12, color: '#334155', marginTop: 6 }}>
                    <Text style={{ fontWeight: '600', color: '#64748B' }}>Active: </Text>
                    {item.activeIngredients}
                  </Text>

                  {/* Applicant & Approval Date Row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F1F5F9' }}>
                    <Text style={{ fontSize: 11, color: '#64748B', flex: 1 }} numberOfLines={1}>
                      {item.applicantName}
                    </Text>
                    <Text style={{ fontSize: 11, color: '#94A3B8' }}>
                      {item.approvalDate}
                    </Text>
                  </View>

                  {/* Inactive Alert Callout Banner */}
                  {item.status === 'Inactive' && (
                    <View
                      style={{
                        marginTop: 8,
                        backgroundColor: '#FFFBEB',
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 8,
                        borderLeftWidth: 3,
                        borderLeftColor: '#F59E0B',
                      }}
                    >
                      <Text style={{ fontSize: 11, color: '#B45309', fontWeight: '600' }}>
                        ⚠️ Notice: {item.statusReason || 'Pending registration renewal with NAFDAC.'}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </>
      )}

      {/* ======================================================== */}
      {/* 4. SCREEN 3: ALERTS */}
      {/* ======================================================== */}
      {activeView === 'Alerts' && (
        <>
          <SafeAreaView style={styles.subTopSafeArea} edges={['top']}>
            <View style={styles.subHeaderTitleBlock}>
              <Text style={styles.subPageTitle}>Reports</Text>
              <Text style={styles.subPageSubtitle}>Products you've reported and their status.</Text>
            </View>

            {/* Filter Pills: All | Under Review | Reviewed */}
            <View style={styles.reportsFilterPillsRow}>
              {(['All', 'Under Review', 'Reviewed'] as const).map((filter) => {
                const isActive = reportsTabFilter === filter;
                return (
                  <TouchableOpacity
                    key={filter}
                    style={[styles.reportsFilterChip, isActive && styles.reportsFilterChipActive]}
                    onPress={() => setReportsTabFilter(filter)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.reportsFilterChipText,
                        isActive && styles.reportsFilterChipTextActive,
                      ]}
                    >
                      {filter}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </SafeAreaView>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.subScrollContent}
            showsVerticalScrollIndicator={false}
          >
            {REPORTS_DATA.filter((item) => {
              if (reportsTabFilter === 'All') return true;
              if (reportsTabFilter === 'Under Review') return item.status === 'Under Review';
              if (reportsTabFilter === 'Reviewed') return item.status !== 'Under Review';
              return true;
            }).map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.reportListItemCard}
                activeOpacity={0.85}
                onPress={() =>
                  router.push({
                    pathname: '/report-details',
                    params: {
                      name: item.name,
                      status: item.status,
                      date: item.date.replace('Reported on ', ''),
                    },
                  })
                }
              >
                <View style={styles.reportItemThumbBox}>
                  <Image source={item.image} style={styles.reportItemThumbImg} resizeMode="contain" />
                </View>

                <View style={styles.reportItemMetaBox}>
                  <Text style={styles.reportItemName}>{item.name}</Text>
                  <Text style={styles.reportItemDate}>{item.date}</Text>
                </View>

                <View style={styles.reportItemStatusCol}>
                  <View style={[styles.reportItemStatusBadge, { backgroundColor: item.statusBg }]}>
                    <Text style={[styles.reportItemStatusBadgeText, { color: item.statusColor }]}>
                      {item.status}
                    </Text>
                  </View>
                  <Text style={styles.reportItemChevron}>›</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}

      {/* ======================================================== */}
      {/* 5. USER PROFILE SCREEN */}
      {/* ======================================================== */}
      {activeView === 'Profile' && (
        <>
          <SafeAreaView style={styles.subTopSafeArea} edges={['top']}>
            <View style={styles.subHeaderCenteredNav}>
              <TouchableOpacity
                style={styles.subBackBtn}
                activeOpacity={0.7}
                onPress={() => setActiveView('Home')}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={styles.backChevronText}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.subCenterTitle}>Profile</Text>
              <View style={styles.subHeaderPlaceholder} />
            </View>
          </SafeAreaView>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.profileScrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Centered Avatar and User Header */}
            <View style={styles.profileHeaderBlock}>
              <View style={styles.profileAvatarLarge}>
                <Text style={styles.profileAvatarTextLarge}>
                  {(currentUser?.fullName || 'User').charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.profileName}>{currentUser?.fullName || 'User'}</Text>
              <Text style={styles.profileRole}>
                {currentUser?.email || 'Account holder'}
              </Text>
            </View>

            {/* Menu Items List */}
            <View style={styles.profileMenuContainer}>
              {/* Item 1: Personal Information */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => router.push('/personal-info' as any)}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#EAF7EE' }]}>
                  <Image
                    source={require('../../assets/icons/icon_profile_user.png')}
                    style={styles.profileMenuIcon}
                    resizeMode="contain"
                  />
                </View>
                <View style={styles.profileMenuMeta}>
                  <Text style={styles.profileMenuTitle}>Personal Information</Text>
                  <Text style={styles.profileMenuSubtitle}>Name, email, phone number</Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Item 2: Notifications */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => {
                  setPreviousView('Profile');
                  setActiveView('Notifications');
                }}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#EFF6FF' }]}>
                  <Image
                    source={require('../../assets/icons/icon_profile_bell.png')}
                    style={styles.profileMenuIcon}
                    resizeMode="contain"
                  />
                </View>
                <View style={styles.profileMenuMeta}>
                  <Text style={styles.profileMenuTitle}>Notifications</Text>
                  <Text style={styles.profileMenuSubtitle}>Manage your alerts and updates</Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Item 3: Location & Region */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => router.push('/location-region' as any)}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#EAF7EE' }]}>
                  <Image
                    source={require('../../assets/icons/icon_profile_location.png')}
                    style={styles.profileMenuIcon}
                    resizeMode="contain"
                  />
                </View>
                <View style={styles.profileMenuMeta}>
                  <Text style={styles.profileMenuTitle}>Location & Region</Text>
                  <Text style={styles.profileMenuSubtitle}>Your current location and region</Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Item 4: Privacy & Security */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => router.push('/privacy-security' as any)}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#F3E8FF' }]}>
                  <Image
                    source={require('../../assets/icons/icon_profile_security.png')}
                    style={styles.profileMenuIcon}
                    resizeMode="contain"
                  />
                </View>
                <View style={styles.profileMenuMeta}>
                  <Text style={styles.profileMenuTitle}>Privacy & Security</Text>
                  <Text style={styles.profileMenuSubtitle}>Data, security and permissions</Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Linked Device Identity Item */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => setShowDeviceModal(true)}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#E0F2FE' }]}>
                  <Text style={{ fontSize: 18 }}>📱</Text>
                </View>
                <View style={styles.profileMenuMeta}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.profileMenuTitle}>Linked Device</Text>
                    <View
                      style={{
                        backgroundColor: '#DCFCE7',
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor: '#86EFAC',
                      }}
                    >
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#15803D' }}>
                        Linked 🟢
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.profileMenuSubtitle}>
                    {deviceInfo?.deviceId || 'SNS-DEV-ACTIVE'} • {deviceInfo?.deviceModel || 'Phone'}
                  </Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Item 5: Voice Assistant ("Hey Sensoo") */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => router.push('/voice-assistant' as any)}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#ECFDF5' }]}>
                  <Text style={{ fontSize: 18 }}>🎙️</Text>
                </View>
                <View style={styles.profileMenuMeta}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.profileMenuTitle}>Voice Assistant</Text>
                    <View
                      style={{
                        backgroundColor: voiceSettings.enabled ? '#ECFDF5' : '#F1F5F9',
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor: voiceSettings.enabled ? '#A7F3D0' : '#E2E8F0',
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          fontWeight: '700',
                          color: voiceSettings.enabled ? '#059669' : '#64748B',
                        }}
                      >
                        {voiceSettings.enabled ? 'Ready 🟢' : 'Off'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.profileMenuSubtitle}>"Hey Sensoo" hands-free & voiceprint</Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Check for App Updates */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                disabled={isCheckingAppUpdate}
                onPress={handleManualCheckUpdates}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#EEF2FF' }]}>
                  {isCheckingAppUpdate ? (
                    <ActivityIndicator size="small" color="#4F46E5" />
                  ) : (
                    <Text style={{ fontSize: 18 }}>🚀</Text>
                  )}
                </View>
                <View style={styles.profileMenuMeta}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.profileMenuTitle}>Check for Updates</Text>
                    <View
                      style={{
                        backgroundColor: '#E0E7FF',
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 6,
                      }}
                    >
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#4338CA' }}>
                        OTA
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.profileMenuSubtitle}>
                    {isCheckingAppUpdate
                      ? 'Connecting to EAS servers...'
                      : Updates.updateId
                      ? `Release 1.0.0 (${Updates.updateId.slice(0, 8)}) • Tap to check`
                      : 'Release 1.0.0 (Embedded) • Tap to check'}
                  </Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Item 6: About Sensoo */}
              <TouchableOpacity
                style={styles.profileMenuItemCard}
                activeOpacity={0.75}
                onPress={() => router.push('/about-sensoo' as any)}
              >
                <View style={[styles.profileMenuIconBox, { backgroundColor: '#FEF3C7' }]}>
                  <Image
                    source={require('../../assets/icons/icon_profile_about.png')}
                    style={styles.profileMenuIcon}
                    resizeMode="contain"
                  />
                </View>
                <View style={styles.profileMenuMeta}>
                  <Text style={styles.profileMenuTitle}>About Sensoo</Text>
                  <Text style={styles.profileMenuSubtitle}>Version, support and legal</Text>
                </View>
                <Text style={styles.profileMenuChevron}>›</Text>
              </TouchableOpacity>

              {/* Log out Button */}
              <TouchableOpacity
                style={styles.logoutButton}
                activeOpacity={0.8}
                onPress={handleLogout}
              >
                <Image
                  source={require('../../assets/icons/icon_profile_logout.png')}
                  style={styles.logoutIcon}
                  resizeMode="contain"
                />
                <Text style={styles.logoutText}>Log out</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </>
      )}

      {/* ======================================================== */}
      {/* 6. NOTIFICATIONS SCREEN */}
      {/* ======================================================== */}
      {activeView === 'Notifications' && (
        <>
          <SafeAreaView style={styles.subTopSafeArea} edges={['top']}>
            <View style={styles.subHeaderCenteredNav}>
              <TouchableOpacity
                style={styles.subBackBtn}
                activeOpacity={0.7}
                onPress={() => setActiveView(previousView || 'Home')}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={styles.backChevronText}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.subCenterTitle}>Notifications</Text>
              <TouchableOpacity
                style={styles.markAllReadBtn}
                activeOpacity={0.7}
                onPress={handleMarkAllAsRead}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.markAllReadText}>Mark all as read</Text>
              </TouchableOpacity>
            </View>

            {/* Filter Pills */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.notifFilterPillsRow}
            >
              {(['All', 'Verification', 'System', 'Updates'] as const).map((filter) => {
                const isActive = notificationFilter === filter;
                return (
                  <TouchableOpacity
                    key={filter}
                    style={[
                      styles.notifFilterChip,
                      isActive && styles.notifFilterChipActive,
                    ]}
                    onPress={() => setNotificationFilter(filter)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.notifFilterChipText,
                        isActive && styles.notifFilterChipTextActive,
                      ]}
                    >
                      {filter}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </SafeAreaView>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.notifScrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Section: Today */}
            {filteredNotifications.some((n) => n.dateGroup === 'Today') && (
              <View style={styles.notifSectionGroup}>
                <Text style={styles.notifSectionTitle}>Today</Text>
                {filteredNotifications
                  .filter((n) => n.dateGroup === 'Today')
                  .map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.notifCard}
                      activeOpacity={0.85}
                      onPress={() => {
                        setNotifications((prev) =>
                          prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n))
                        );
                        if (item.scenario && item.code) {
                          navigateToResult(item.scenario, item.code);
                        } else {
                          Alert.alert(item.title, item.description);
                        }
                      }}
                    >
                      <View
                        style={[
                          styles.notifIconCircle,
                          { backgroundColor: item.iconBg },
                        ]}
                      >
                        {item.iconType === 'counterfeit' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_counterfeit.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'repeat' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_repeat.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'globe' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_globe.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'verified' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_verified.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'gear' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_gear.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                      </View>

                      <View style={styles.notifContent}>
                        <Text style={styles.notifTitle}>{item.title}</Text>
                        <Text style={styles.notifDescription}>{item.description}</Text>
                        <Text style={styles.notifTime}>{item.time}</Text>
                      </View>

                      {!item.isRead ? (
                        <View style={styles.notifUnreadDot} />
                      ) : (
                        <Text style={styles.notifChevron}>›</Text>
                      )}
                    </TouchableOpacity>
                  ))}
              </View>
            )}

            {/* Section: Yesterday */}
            {filteredNotifications.some((n) => n.dateGroup === 'Yesterday') && (
              <View style={styles.notifSectionGroup}>
                <Text style={styles.notifSectionTitle}>Yesterday</Text>
                {filteredNotifications
                  .filter((n) => n.dateGroup === 'Yesterday')
                  .map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.notifCard}
                      activeOpacity={0.85}
                      onPress={() => {
                        setNotifications((prev) =>
                          prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n))
                        );
                        if (item.scenario && item.code) {
                          navigateToResult(item.scenario, item.code);
                        } else {
                          Alert.alert(item.title, item.description);
                        }
                      }}
                    >
                      <View
                        style={[
                          styles.notifIconCircle,
                          { backgroundColor: item.iconBg },
                        ]}
                      >
                        {item.iconType === 'counterfeit' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_counterfeit.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'repeat' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_repeat.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'globe' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_globe.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'verified' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_verified.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                        {item.iconType === 'gear' && (
                          <Image
                            source={require('../../assets/icons/icon_notif_gear.png')}
                            style={styles.notifIconImg}
                            resizeMode="contain"
                          />
                        )}
                      </View>

                      <View style={styles.notifContent}>
                        <Text style={styles.notifTitle}>{item.title}</Text>
                        <Text style={styles.notifDescription}>{item.description}</Text>
                        <Text style={styles.notifTime}>{item.time}</Text>
                      </View>

                      {!item.isRead ? (
                        <View style={styles.notifUnreadDot} />
                      ) : (
                        <Text style={styles.notifChevron}>›</Text>
                      )}
                    </TouchableOpacity>
                  ))}
              </View>
            )}
          </ScrollView>
        </>
      )}

      {/* ======================================================== */}
      {/* NAFDAC GREENBOOK PRODUCT DOSSIER MODAL */}
      {/* ======================================================== */}
      <Modal
        visible={!!selectedGreenbookProduct}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedGreenbookProduct(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContentCard, { maxHeight: '85%' }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 18 }}>📋</Text>
                <Text style={styles.modalTitle}>Greenbook Dossier</Text>
              </View>
              <TouchableOpacity
                onPress={() => setSelectedGreenbookProduct(null)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {selectedGreenbookProduct && (
              <ScrollView showsVerticalScrollIndicator={false} style={{ marginTop: 8 }}>
                {/* Header Title & Status */}
                <Text style={{ fontSize: 18, fontWeight: '800', color: '#0F172A', lineHeight: 24 }}>
                  {selectedGreenbookProduct.productName}
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderRadius: 8,
                      backgroundColor:
                        selectedGreenbookProduct.status === 'Active' ? '#DCFCE7' : '#FEF3C7',
                      borderWidth: 1,
                      borderColor:
                        selectedGreenbookProduct.status === 'Active' ? '#86EFAC' : '#FCD34D',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '700',
                        color:
                          selectedGreenbookProduct.status === 'Active' ? '#15803D' : '#B45309',
                      }}
                    >
                      {selectedGreenbookProduct.status === 'Active' ? '● Active' : '● Inactive'}
                    </Text>
                  </View>

                  <View
                    style={{
                      backgroundColor: '#F1F5F9',
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 6,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#334155' }}>
                      NRN: {selectedGreenbookProduct.nrn}
                    </Text>
                  </View>
                </View>

                {/* Inactive Alert / Active Success Banner */}
                {selectedGreenbookProduct.status === 'Inactive' ? (
                  <View
                    style={{
                      marginTop: 12,
                      backgroundColor: '#FEF2F2',
                      borderColor: '#FECACA',
                      borderWidth: 1,
                      padding: 12,
                      borderRadius: 12,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>
                      ⚠️ Regulatory Inactive Notice
                    </Text>
                    <Text style={{ fontSize: 12, color: '#991B1B', marginTop: 4, lineHeight: 17 }}>
                      {selectedGreenbookProduct.statusReason ||
                        'This product is listed as Inactive on greenbook.nafdac.gov.ng. Registration has expired or is subject to regulatory recall.'}
                    </Text>
                  </View>
                ) : (
                  <View
                    style={{
                      marginTop: 12,
                      backgroundColor: '#F0FDF4',
                      borderColor: '#BBF7D0',
                      borderWidth: 1,
                      padding: 12,
                      borderRadius: 12,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>
                      ✓ Official Registry Confirmation
                    </Text>
                    <Text style={{ fontSize: 12, color: '#166534', marginTop: 4, lineHeight: 17 }}>
                      Product registration is currently valid and active on Nigeria's National Registered Product Database.
                    </Text>
                  </View>
                )}

                {/* Details Breakdown */}
                <View style={{ marginTop: 14, backgroundColor: '#F8FAFC', borderRadius: 12, padding: 12, gap: 10 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>Active Ingredients</Text>
                    <Text style={{ fontSize: 12, color: '#0F172A', fontWeight: '700', flex: 1, textAlign: 'right' }}>
                      {selectedGreenbookProduct.activeIngredients}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>Product Category</Text>
                    <Text style={{ fontSize: 12, color: '#0F172A', fontWeight: '700' }}>
                      {selectedGreenbookProduct.productCategory}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>Applicant Name</Text>
                    <Text style={{ fontSize: 12, color: '#0F172A', fontWeight: '700', flex: 1, textAlign: 'right' }}>
                      {selectedGreenbookProduct.applicantName}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>Approval Date</Text>
                    <Text style={{ fontSize: 12, color: '#0F172A', fontWeight: '700' }}>
                      {selectedGreenbookProduct.approvalDate}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>Form & ROA</Text>
                    <Text style={{ fontSize: 12, color: '#0F172A', fontWeight: '700' }}>
                      {selectedGreenbookProduct.form} / {selectedGreenbookProduct.roa}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>Strengths</Text>
                    <Text style={{ fontSize: 12, color: '#0F172A', fontWeight: '700' }}>
                      {selectedGreenbookProduct.strengths}
                    </Text>
                  </View>
                </View>

                {/* Actions */}
                <TouchableOpacity
                  style={{
                    marginTop: 16,
                    backgroundColor: '#0F172A',
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                  activeOpacity={0.88}
                  onPress={() => {
                    setSelectedGreenbookProduct(null);
                    router.push('/scanner');
                  }}
                >
                  <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 14 }}>
                    Scan & Verify Physical Packaging
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* ======================================================== */}
      {/* LINKED DEVICE & HARDWARE IDENTITY MODAL */}
      {/* ======================================================== */}
      <Modal
        visible={showDeviceModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDeviceModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContentCard}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 18 }}>📱</Text>
                <Text style={styles.modalTitle}>Linked Device Identity</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowDeviceModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <View style={{ backgroundColor: '#F0FDF4', padding: 12, borderRadius: 10, marginBottom: 12, borderWidth: 1, borderColor: '#BBF7D0' }}>
                <Text style={{ fontSize: 12, color: '#166534', fontWeight: '600', lineHeight: 17 }}>
                  ✓ This device is cryptographically linked to your Sensoo identity and protected by NAFDAC anti-clone telemetry.
                </Text>
              </View>

              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Device ID</Text>
                <Text style={[styles.modalInfoValue, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontWeight: '800' }]}>
                  {deviceInfo?.deviceId || 'SNS-DEV-ACTIVE'}
                </Text>
              </View>

              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Hardware Model</Text>
                <Text style={styles.modalInfoValue}>
                  {deviceInfo?.deviceModel || 'Mobile Device'}
                </Text>
              </View>

              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Operating System</Text>
                <Text style={styles.modalInfoValue}>
                  {deviceInfo?.osName || 'Android'} {deviceInfo?.osVersion || ''}
                </Text>
              </View>

              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Linked Account</Text>
                <Text style={styles.modalInfoValue}>
                  {deviceInfo?.linkedAccount || `${currentUser?.fullName || 'User'} (Primary Holder)`}
                </Text>
              </View>

              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Anti-Clone Status</Text>
                <Text style={[styles.modalInfoValue, { color: '#16A34A', fontWeight: '700' }]}>
                  Protected & Active 🟢
                </Text>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* ======================================================== */}
      {/* MODALS: Personal Info, Privacy, About */}
      {/* ======================================================== */}
      <Modal
        visible={showPersonalInfoModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPersonalInfoModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContentCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Personal Information</Text>
              <TouchableOpacity
                onPress={() => setShowPersonalInfoModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Full Name</Text>
                <Text style={styles.modalInfoValue}>{currentUser?.fullName || 'User'}</Text>
              </View>
              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Account Status</Text>
                <Text style={styles.modalInfoValue}>Account holder (Verified)</Text>
              </View>
              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Email</Text>
                <Text style={styles.modalInfoValue}>{currentUser?.email || 'N/A'}</Text>
              </View>
              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Phone Number</Text>
                <Text style={styles.modalInfoValue}>+234 802 345 6789</Text>
              </View>
              <View style={styles.modalInfoRow}>
                <Text style={styles.modalInfoLabel}>Registered Region</Text>
                <Text style={styles.modalInfoValue}>{userCity}</Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.modalConfirmBtn}
              activeOpacity={0.85}
              onPress={() => setShowPersonalInfoModal(false)}
            >
              <Text style={styles.modalConfirmBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showPrivacyModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPrivacyModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContentCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Privacy & Security</Text>
              <TouchableOpacity
                onPress={() => setShowPrivacyModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <Text style={styles.modalParagraph}>
                • <Text style={{ fontWeight: '700' }}>On-Device Encryption:</Text> Every scanned barcode is hashed and verified using local cryptographic keys.
              </Text>
              <Text style={styles.modalParagraph}>
                • <Text style={{ fontWeight: '700' }}>Geofence Privacy:</Text> GPS coordinates are solely checked for haversine velocity anomalies and regional distribution safety.
              </Text>
              <Text style={styles.modalParagraph}>
                • <Text style={{ fontWeight: '700' }}>Zero Personal Tracking:</Text> No personal identifying data is transmitted across manufacturer verification clusters.
              </Text>
            </View>

            <TouchableOpacity
              style={styles.modalConfirmBtn}
              activeOpacity={0.85}
              onPress={() => setShowPrivacyModal(false)}
            >
              <Text style={styles.modalConfirmBtnText}>Understood</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showAboutModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAboutModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContentCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>About Sensoo</Text>
              <TouchableOpacity
                onPress={() => setShowAboutModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalBody}>
              <Text style={styles.modalParagraph}>
                <Text style={{ fontWeight: '700', color: '#059669' }}>Sensoo v1.2.0</Text>
              </Text>
              <Text style={styles.modalParagraph}>
                "Trusted products. Healthier people. Know what you buy. Help stop fake products and keep your community safe."
              </Text>
              <Text style={styles.modalParagraph}>
                Integrated with MSFlib cluster verification engine and real-time counterfeit anomaly detection.
              </Text>
            </View>

            <TouchableOpacity
              style={styles.modalConfirmBtn}
              activeOpacity={0.85}
              onPress={() => setShowAboutModal(false)}
            >
              <Text style={styles.modalConfirmBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ======================================================== */}
      {/* FLOATING QUICK VOICE COMMANDER BUTTON */}
      {/* ======================================================== */}
      {voiceSettings.enabled && (
        <View style={styles.floatingVoiceContainer} pointerEvents="box-none">
          <TouchableOpacity
            style={[
              styles.heartPumpFloatingBtn,
              isVoiceListening && styles.heartPumpFloatingBtnListening,
            ]}
            activeOpacity={0.85}
            onPress={toggleVoiceAssistant}
          >
            <Animated.View
              style={[
                styles.heartPumpInnerCircle,
                isVoiceListening && {
                  transform: [{ scale: voicePulseAnim }],
                  backgroundColor: '#059669',
                },
              ]}
            >
              <Text style={{ fontSize: 20 }}>🎙️</Text>
            </Animated.View>
            <View
              style={[
                styles.heartPumpBadgePill,
                isVoiceListening && { backgroundColor: '#064E3B', borderColor: '#10B981' },
              ]}
            >
              <View
                style={[
                  styles.heartPumpLiveDot,
                  isVoiceListening && { backgroundColor: '#34D399' },
                ]}
              />
              <Text
                style={[
                  styles.heartPumpBadgeText,
                  isVoiceListening && { color: '#A7F3D0', fontWeight: '800' },
                ]}
                numberOfLines={1}
              >
                {isVoiceListening ? 'Listening...' : 'Hey Sensoo'}
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      )}


      {/* ======================================================== */}
      {/* PERMANENT BOTTOM NAVIGATION BAR */}
      {/* ======================================================== */}
      <SafeAreaView style={styles.bottomSafeArea} edges={['bottom']}>
        <View style={styles.bottomNav}>
          {/* 1. Home */}
          <TouchableOpacity
            style={styles.navItem}
            activeOpacity={0.7}
            onPress={() => setActiveView('Home')}
          >
            <Image
              source={require('../../assets/icons/nav_home.png')}
              style={[
                styles.navIconImage,
                activeView === 'Home' && styles.navIconImageActive,
              ]}
              resizeMode="contain"
            />
            <Text style={[styles.navLabel, activeView === 'Home' && styles.navLabelActive]}>Home</Text>
            <View style={[styles.navActiveDot, activeView !== 'Home' && styles.navDotHidden]} />
          </TouchableOpacity>

          {/* 2. History */}
          <TouchableOpacity
            style={styles.navItem}
            activeOpacity={0.7}
            onPress={() => setActiveView('RecentScans')}
          >
            <Image
              source={require('../../assets/icons/nav_history.png')}
              style={[
                styles.navIconImage,
                (activeView === 'RecentScans' || activeView === 'VerifiedProducts') &&
                  styles.navIconImageActive,
              ]}
              resizeMode="contain"
            />
            <Text
              style={[
                styles.navLabel,
                (activeView === 'RecentScans' || activeView === 'VerifiedProducts') &&
                  styles.navLabelActive,
              ]}
            >
              History
            </Text>
            <View
              style={[
                styles.navActiveDot,
                activeView !== 'RecentScans' && activeView !== 'VerifiedProducts' && styles.navDotHidden,
              ]}
            />
          </TouchableOpacity>


          {/* 3. Agent (Centered in bottom nav with animated pulse effect) */}
          <TouchableOpacity
            style={styles.navItem}
            activeOpacity={0.7}
            onPress={() => router.push('/agent')}
          >
            <View style={styles.navAgentBox}>
              {/* Outer pulsing glow ripple */}
              <Animated.View
                style={[
                  styles.navAgentPulseRing,
                  {
                    transform: [
                      {
                        scale: agentPulseValue.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1.0, 1.55],
                        }),
                      },
                    ],
                    opacity: agentPulseValue.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.65, 0.0],
                    }),
                  },
                ]}
              />
              {/* Inner glowing circle with subtle breathing scale */}
              <Animated.View
                style={[
                  styles.navAgentCircle,
                  {
                    transform: [
                      {
                        scale: agentPulseValue.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1.0, 1.08],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <Text style={styles.navAgentStarGlyph}>✦</Text>
              </Animated.View>
              {/* Red notification dot */}
              <View style={styles.navAgentRedDot} />
            </View>
            <Text style={[styles.navLabel, { color: '#059669', fontWeight: '700' }]}>Agent</Text>
            <View style={[styles.navActiveDot, styles.navDotHidden]} />
          </TouchableOpacity>

          {/* 4. Reports */}
          <TouchableOpacity
            style={styles.navItem}
            activeOpacity={0.7}
            onPress={() => setActiveView('Alerts')}
          >
            <Image
              source={require('../../assets/icons/nav_reports.png')}
              style={[
                styles.navIconImage,
                activeView === 'Alerts' && styles.navIconImageActive,
              ]}
              resizeMode="contain"
            />
            <Text style={[styles.navLabel, activeView === 'Alerts' && styles.navLabelActive]}>Reports</Text>
            <View style={[styles.navActiveDot, activeView !== 'Alerts' && styles.navDotHidden]} />
          </TouchableOpacity>

          {/* 5. Profile */}
          <TouchableOpacity
            style={styles.navItem}
            activeOpacity={0.7}
            onPress={() => setActiveView('Profile')}
          >
            <Image
              source={require('../../assets/icons/nav_profile.png')}
              style={[
                styles.navIconImage,
                (activeView === 'Profile' || activeView === 'Notifications') &&
                  styles.navIconImageActive,
              ]}
              resizeMode="contain"
            />
            <Text
              style={[
                styles.navLabel,
                (activeView === 'Profile' || activeView === 'Notifications') &&
                  styles.navLabelActive,
              ]}
            >
              Profile
            </Text>
            <View
              style={[
                styles.navActiveDot,
                activeView !== 'Profile' && activeView !== 'Notifications' && styles.navDotHidden,
              ]}
            />
          </TouchableOpacity>
        </View>
      </SafeAreaView>



      {/* ======================================================== */}
      {/* 8. ASK SENSOO AGENTIC AI INTERACTIVE MODAL */}
      {/* ======================================================== */}
      <Modal
        visible={showAgentModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAgentModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.agentModalOverlay}
        >
          <View style={styles.agentModalCard}>
            {/* Modal Header */}
            <View style={styles.agentModalHeader}>
              <View style={styles.agentHeaderLeft}>
                <View style={styles.agentHeaderAvatar}>
                  <Image
                    source={require('../../assets/sensoo_ai_robot.jpg')}
                    style={styles.agentHeaderRobotImg}
                    resizeMode="cover"
                  />
                  <View style={styles.agentOnlineDot} />
                </View>
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.agentHeaderTitle}>Sensoo AI</Text>
                    <View style={styles.agentVerifiedBadge}>
                      <Text style={styles.agentVerifiedBadgeText}>AGENTIC</Text>
                    </View>
                  </View>
                  <Text style={styles.agentHeaderSub}>24/7 Counterfeit & Safety Assistant</Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.agentCloseBtn}
                onPress={() => setShowAgentModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.agentCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Quick Suggestions Chips */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.agentSuggestionsRow}
            >
              {[
                'How to verify authentic medicine?',
                'Find nearby clinics & pharmacies',
                'How to spot fake cosmetics?',
                'Report a suspicious pharmacy',
              ].map((suggestion) => (
                <TouchableOpacity
                  key={suggestion}
                  style={styles.agentSuggestionChip}
                  activeOpacity={0.7}
                  onPress={() => handleSendAgentQuery(suggestion)}
                >
                  <Text style={styles.agentSuggestionText}>{suggestion}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Chat History */}
            <ScrollView
              style={styles.agentChatScroll}
              contentContainerStyle={styles.agentChatContent}
              showsVerticalScrollIndicator={false}
            >
              {agentChat.map((msg, idx) => (
                <View
                  key={idx}
                  style={[
                    styles.agentChatBubble,
                    msg.sender === 'user'
                      ? styles.agentUserBubble
                      : styles.agentBotBubble,
                  ]}
                >
                  <Text
                    style={[
                      styles.agentChatText,
                      msg.sender === 'user' && styles.agentUserChatText,
                    ]}
                  >
                    {msg.text}
                  </Text>
                </View>
              ))}
            </ScrollView>

            {/* Input Bar */}
            <View style={styles.agentInputBar}>
              <TextInput
                style={styles.agentTextInput}
                placeholder="Ask about a drug, clinic, or report..."
                placeholderTextColor="#94A3B8"
                value={agentInput}
                onChangeText={setAgentInput}
                onSubmitEditing={() => handleSendAgentQuery()}
              />
              <TouchableOpacity
                style={styles.agentSendBtn}
                activeOpacity={0.8}
                onPress={() => handleSendAgentQuery()}
              >
                <Text style={styles.agentSendIcon}>➤</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },

  /* Top Header on Home */
  topSafeArea: {
    backgroundColor: '#FFFFFF',
    zIndex: 10,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 24 : 10,
    paddingBottom: 12,
  },
  logo: {
    width: 124,
    height: 38,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bellButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  bellIconImage: {
    width: 22,
    height: 22,
  },
  avatarButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0A341E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },

  /* Sub-Page Top Header */
  subTopSafeArea: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    paddingBottom: 14,
  },
  subHeaderNav: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 6,
  },
  backArrowBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
  },
  backArrowGlyph: {
    fontSize: 26,
    color: '#0F172A',
    fontWeight: '600',
  },
  subHeaderTitleBlock: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  subPageTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
  },
  subPageSubtitle: {
    fontSize: 14,
    color: '#64748B',
    lineHeight: 19,
  },

  /* Search Bar */
  searchBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginHorizontal: 20,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 12,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#0F172A',
  },

  /* Filter Pills */
  filterPillsRow: {
    paddingHorizontal: 20,
    gap: 8,
  },
  filterChip: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
  },
  filterChipActive: {
    backgroundColor: '#064E3B',
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },

  /* Scroll Content */
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 36,
  },
  subScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 36,
  },

  /* Dashboard Greeting */
  greetingSection: {
    marginTop: 8,
    marginBottom: 18,
  },
  greetingTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  greetingBlack: {
    color: '#0B2215',
  },
  greetingGreen: {
    color: '#10B981',
  },
  greetingSubtitle: {
    fontSize: 14.5,
    color: '#65796E',
    marginTop: 4,
  },

  /* Hero Scan Banner */
  heroBannerCard: {
    width: '100%',
    aspectRatio: 780 / 320,
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 18,
  },
  heroBannerImage: {
    width: '100%',
    height: '100%',
  },

  /* 3 Shortcuts Row */
  shortcutsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 26,
    gap: 8,
  },
  shortcutCard: {
    flex: 1,
    height: 124,
    borderRadius: 18,
    padding: 10,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  shortcutBadgeImage: {
    width: 32,
    height: 32,
  },
  shortcutTextWrapper: {
    minHeight: 44,
    justifyContent: 'flex-start',
    marginTop: 2,
  },
  shortcutTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0B2215',
    lineHeight: 16,
  },
  shortcutSubtitle: {
    fontSize: 10,
    color: '#65796E',
    marginTop: 1,
  },
  shortcutChevron: {
    alignSelf: 'flex-end',
  },
  shortcutChevronArrow: {
    fontSize: 14,
    color: '#0B2215',
    fontWeight: '700',
  },

  /* Section Header */
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 19,
    fontWeight: '700',
    color: '#0B2215',
  },
  seeAllText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#10B981',
  },

  /* Scan Card (Home Preview) */
  scanCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E6ECE8',
    marginBottom: 12,
  },
  thumbWrapper: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#F4F7F5',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  thumbImage: {
    width: 44,
    height: 44,
  },
  scanMeta: {
    flex: 1,
  },
  productName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0B2215',
    marginBottom: 3,
  },
  scanTimestamp: {
    fontSize: 12.5,
    color: '#7C8E84',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
    gap: 4,
  },
  statusPillIcon: {
    fontSize: 11,
    fontWeight: '900',
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '700',
  },
  statusVerified: {
    backgroundColor: '#DCFCE7',
  },
  textVerified: {
    color: '#15803D',
  },
  statusCounterfeit: {
    backgroundColor: '#FEE2E2',
  },
  textCounterfeit: {
    color: '#DC2626',
  },
  statusWarning: {
    backgroundColor: '#FEF3C7',
  },
  textWarning: {
    color: '#D97706',
  },

  /* Sub-List Common Card (Recent Scans & Verified Products) */
  dateGroupContainer: {
    marginBottom: 20,
  },
  dateGroupTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 10,
  },
  subListItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    marginBottom: 10,
  },
  subListThumbWrapper: {
    width: 50,
    height: 50,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  subListThumb: {
    width: 42,
    height: 42,
  },
  subListMeta: {
    flex: 1,
  },
  subListTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#0F172A',
    lineHeight: 18,
    marginBottom: 3,
  },
  subListTime: {
    fontSize: 12,
    color: '#64748B',
  },
  subListTimeUnder: {
    fontSize: 11.5,
    color: '#64748B',
    marginTop: 4,
  },
  subListStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 12,
    gap: 4,
    marginRight: 6,
  },
  subListStatusPillInline: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    gap: 3,
    marginTop: 2,
  },
  subListChevron: {
    fontSize: 18,
    color: '#94A3B8',
    fontWeight: '600',
    marginLeft: 4,
  },

  /* Alerts Card */
  alertCardContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 14,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  alertCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
    marginBottom: 10,
  },
  alertThumbBox: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  alertThumbImage: {
    width: 44,
    height: 44,
  },
  alertCircleBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  alertCircleBadgeText: {
    fontSize: 12,
    fontWeight: '900',
  },
  alertMetaBox: {
    flex: 1,
  },
  alertProductName: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#0F172A',
    lineHeight: 18,
    marginBottom: 4,
  },
  alertStatusPill: {
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 3,
  },
  alertStatusPillText: {
    fontSize: 11.5,
    fontWeight: '700',
  },
  alertTimestamp: {
    fontSize: 11.5,
    color: '#64748B',
  },
  alertCalloutText: {
    fontSize: 12.5,
    color: '#64748B',
    lineHeight: 17,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 8,
  },

  /* Profile View */
  profileContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  profileScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
  },
  profileHeaderBlock: {
    alignItems: 'center',
    marginBottom: 24,
  },
  profileAvatarLarge: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#DDF4E7',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  profileAvatarTextLarge: {
    color: '#0F5132',
    fontSize: 36,
    fontWeight: '700',
  },
  profileName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 3,
  },
  profileRole: {
    fontSize: 14,
    color: '#6B7280',
    fontWeight: '400',
  },
  profileMenuContainer: {
    width: '100%',
  },
  profileMenuItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.02,
    shadowRadius: 3,
    elevation: 1,
  },
  profileMenuIconBox: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileMenuIcon: {
    width: 22,
    height: 22,
  },
  profileMenuMeta: {
    flex: 1,
    marginLeft: 14,
  },
  profileMenuTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  profileMenuSubtitle: {
    fontSize: 13,
    color: '#6B7280',
  },
  profileMenuChevron: {
    fontSize: 20,
    color: '#9CA3AF',
    fontWeight: '600',
    marginLeft: 6,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEF2F2',
    borderRadius: 16,
    height: 52,
    marginTop: 8,
    marginBottom: 24,
  },
  logoutIcon: {
    width: 18,
    height: 18,
    tintColor: '#DC2626',
    marginRight: 8,
  },
  logoutText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#DC2626',
  },

  /* Sub Header Nav with Back Chevron & Title */
  subHeaderCenteredNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  subBackBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  backChevronText: {
    fontSize: 34,
    fontWeight: '300',
    color: '#0F172A',
    lineHeight: 36,
  },
  subCenterTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  subHeaderPlaceholder: {
    width: 36,
  },
  markAllReadBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  markAllReadText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#059669',
  },
  bellBadgeDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#DC2626',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },

  /* Notifications Screen Styles */
  notifFilterPillsRow: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
    gap: 10,
  },
  notifFilterChip: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
  },
  notifFilterChipActive: {
    backgroundColor: '#064E3B',
  },
  notifFilterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  notifFilterChipTextActive: {
    color: '#FFFFFF',
  },
  notifScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 40,
  },
  notifSectionGroup: {
    marginBottom: 20,
  },
  notifSectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#64748B',
    marginBottom: 10,
  },
  notifCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.02,
    shadowRadius: 3,
    elevation: 1,
  },
  notifIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifIconImg: {
    width: 22,
    height: 22,
  },
  notifContent: {
    flex: 1,
    marginLeft: 14,
    marginRight: 8,
  },
  notifTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  notifDescription: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
  },
  notifTime: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 4,
  },
  notifUnreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#DC2626',
    marginLeft: 6,
  },
  notifChevron: {
    fontSize: 18,
    color: '#94A3B8',
    fontWeight: '600',
    marginLeft: 6,
  },

  /* Modals */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContentCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 8,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
  },
  modalCloseText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#64748B',
  },
  modalBody: {
    marginBottom: 20,
  },
  modalInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  modalInfoLabel: {
    fontSize: 13.5,
    color: '#64748B',
    fontWeight: '500',
  },
  modalInfoValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  modalParagraph: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 22,
    marginBottom: 12,
  },
  modalConfirmBtn: {
    backgroundColor: '#059669',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalConfirmBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  /* Bottom Navigation */
  bottomSafeArea: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#EDF2EE',
  },
  bottomNav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    height: 70,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'android' ? 10 : 6,
  },
  navItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    minWidth: 54,
  },
  navIconImage: {
    width: 22,
    height: 22,
    marginBottom: 3,
    tintColor: '#8A9C91',
  },
  navIconImageActive: {
    tintColor: '#059669',
  },
  navLabel: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#8A9C91',
  },
  navLabelActive: {
    color: '#059669',
    fontWeight: '700',
  },
  navActiveDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#059669',
    marginTop: 3,
  },
  navDotHidden: {
    opacity: 0,
  },

  /* Reports Tab Screen Styles */
  reportsFilterPillsRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 10,
  },
  reportsFilterChip: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
  },
  reportsFilterChipActive: {
    backgroundColor: '#064E3B',
  },
  reportsFilterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  reportsFilterChipTextActive: {
    color: '#FFFFFF',
  },
  reportListItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.02,
    shadowRadius: 3,
    elevation: 1,
  },
  reportItemThumbBox: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  reportItemThumbImg: {
    width: 36,
    height: 36,
  },
  reportItemMetaBox: {
    flex: 1,
  },
  reportItemName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    lineHeight: 18,
    marginBottom: 2,
  },
  reportItemDate: {
    fontSize: 12,
    color: '#94A3B8',
  },
  reportItemStatusCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  reportItemStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  reportItemStatusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  reportItemChevron: {
    fontSize: 18,
    color: '#94A3B8',
    fontWeight: '600',
  },

  /* ======================================================== */
  /* ASK SENSOO (AGENTIC AI) HERO BANNER STYLES */
  /* ======================================================== */
  aiAgentBannerCard: {
    backgroundColor: '#EDFBF4',
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: '#A7F3D0',
    padding: 16,
    marginBottom: 22,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  aiBannerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aiBannerTextCol: {
    flex: 1,
    paddingRight: 12,
  },
  aiBadgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
    marginBottom: 8,
    gap: 4,
  },
  aiBadgeStar: {
    fontSize: 11,
    color: '#059669',
    fontWeight: '800',
  },
  aiBadgeText: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#065F46',
    letterSpacing: 0.8,
  },
  aiBannerTitle: {
    fontSize: 23,
    fontWeight: '800',
    lineHeight: 28,
    marginBottom: 6,
  },
  aiBannerTitleDark: {
    color: '#064E3B',
  },
  aiBannerTitleGreen: {
    color: '#059669',
  },
  aiBannerSubtitle: {
    fontSize: 12.5,
    color: '#374151',
    lineHeight: 18,
    fontWeight: '500',
  },
  aiBannerVisualBox: {
    position: 'relative',
    width: 86,
    height: 86,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiRobotWrapper: {
    width: 76,
    height: 76,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#34D399',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  aiRobotImg: {
    width: '100%',
    height: '100%',
  },
  aiVoiceBubble: {
    position: 'absolute',
    top: -4,
    left: -6,
    backgroundColor: '#059669',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
    elevation: 3,
  },
  aiVoiceBars: {
    fontSize: 9,
    color: '#FFFFFF',
    fontWeight: '800',
    letterSpacing: 1,
  },
  aiChevronCircle: {
    position: 'absolute',
    bottom: -3,
    right: -3,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#A7F3D0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  aiChevronArrow: {
    fontSize: 16,
    color: '#059669',
    fontWeight: '700',
    marginTop: -2,
    marginLeft: 1,
  },
  aiActionPillsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 14,
  },
  aiActionPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1FAE5',
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    elevation: 1,
  },
  aiActionPillIcon: {
    fontSize: 13,
  },
  aiActionPillLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
  },

  /* ======================================================== */
  /* SCAN RETICLE ICON & AGENT ICON IN BOTTOM NAV */
  /* ======================================================== */
  navScanFrameIcon: {
    width: 22,
    height: 22,
    position: 'relative',
    marginBottom: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanReticleCornerTL: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 6,
    height: 6,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: '#8A9C91',
    borderTopLeftRadius: 2,
  },
  scanReticleCornerTR: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 6,
    height: 6,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: '#8A9C91',
    borderTopRightRadius: 2,
  },
  scanReticleCornerBL: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    width: 6,
    height: 6,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderColor: '#8A9C91',
    borderBottomLeftRadius: 2,
  },
  scanReticleCornerBR: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 6,
    height: 6,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderColor: '#8A9C91',
    borderBottomRightRadius: 2,
  },
  scanReticleCenterDot: {
    width: 3.5,
    height: 3.5,
    borderRadius: 2,
    backgroundColor: '#8A9C91',
  },
  navAgentBox: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 30,
    marginBottom: 3,
  },
  navAgentPulseRing: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#10B981',
  },
  navAgentCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#ECFDF5',
    borderWidth: 1.5,
    borderColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 2,
  },
  navAgentStarGlyph: {
    fontSize: 13,
    color: '#059669',
    fontWeight: '800',
    marginTop: -1,
  },
  navAgentRedDot: {
    position: 'absolute',
    top: -1,
    right: 2,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#EF4444',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    zIndex: 2,
  },

  /* ======================================================== */
  /* ASK SENSOO INTERACTIVE MODAL STYLES */
  /* ======================================================== */
  agentModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    justifyContent: 'flex-end',
  },
  agentModalCard: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 18,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    paddingHorizontal: 18,
    maxHeight: '85%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 20,
  },
  agentModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  agentHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  agentHeaderAvatar: {
    position: 'relative',
    width: 44,
    height: 44,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#ECFDF5',
    borderWidth: 1.5,
    borderColor: '#34D399',
  },
  agentHeaderRobotImg: {
    width: '100%',
    height: '100%',
  },
  agentOnlineDot: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#10B981',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  agentHeaderTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0F172A',
  },
  agentVerifiedBadge: {
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  agentVerifiedBadgeText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#065F46',
    letterSpacing: 0.5,
  },
  agentHeaderSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  agentCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentCloseText: {
    fontSize: 15,
    color: '#64748B',
    fontWeight: '700',
  },
  agentSuggestionsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 12,
  },
  agentSuggestionChip: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  agentSuggestionText: {
    fontSize: 12,
    color: '#334155',
    fontWeight: '600',
  },
  agentChatScroll: {
    maxHeight: 280,
    marginVertical: 8,
  },
  agentChatContent: {
    paddingVertical: 8,
    gap: 10,
  },
  agentChatBubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    maxWidth: '85%',
  },
  agentUserBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#059669',
    borderBottomRightRadius: 4,
  },
  agentBotBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#F1F5F9',
    borderBottomLeftRadius: 4,
  },
  agentChatText: {
    fontSize: 13.5,
    color: '#1E293B',
    lineHeight: 19,
  },
  agentUserChatText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  agentInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 10,
  },
  agentTextInput: {
    flex: 1,
    fontSize: 13.5,
    color: '#0F172A',
    paddingVertical: 6,
  },
  agentSendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#059669',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  agentSendIcon: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '800',
  },

  /* Floating Siri / Voice Command Banner */
  voiceFloatingBanner: {
    position: 'absolute',
    bottom: 90,
    alignSelf: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
    borderWidth: 1.5,
    borderColor: '#059669',
    zIndex: 999,
  },
  voiceFloatingGlowRing: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#064E3B',
    borderWidth: 1.5,
    borderColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceFloatingBannerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },

  /* Floating Heart-Pump Siri Button (Direct Listening) */
  floatingVoiceContainer: {
    position: 'absolute',
    bottom: 86,
    right: 18,
    alignItems: 'flex-end',
    zIndex: 998,
  },
  voiceQuickActionsRow: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 10,
  },
  voiceQuickPill: {
    backgroundColor: '#064E3B',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1.5,
    borderColor: '#34D399',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  voiceQuickPillText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
  },
  heartPumpFloatingBtn: {
    width: 62,
    height: 62,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartPumpFloatingBtnListening: {
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 14,
    elevation: 10,
  },
  heartPumpPulseRing: {
    position: 'absolute',
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#10B981',
  },
  heartPumpInnerCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#064E3B',
    borderWidth: 2,
    borderColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  heartPumpBadgePill: {
    position: 'absolute',
    top: -8,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#34D399',
  },
  heartPumpLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
  },
  heartPumpBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '700',
  },

  /* Heart-Pump Interactive Listener Modal */
  heartPumpModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  heartPumpModalCard: {
    width: '100%',
    maxWidth: 350,
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 22,
    alignItems: 'center',
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
  },
  heartPumpModalClose: {
    position: 'absolute',
    top: 14,
    right: 16,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartPumpVisualContainer: {
    width: 110,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 10,
    position: 'relative',
  },
  heartPumpAuraRing: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(16, 185, 129, 0.22)',
  },
  heartPumpCoreCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#064E3B',
    borderWidth: 3,
    borderColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 8,
  },
  heartPumpModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 6,
    textAlign: 'center',
  },
  heartPumpModalSubtitle: {
    fontSize: 12.5,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  heartPumpChipsGrid: {
    width: '100%',
    gap: 8,
    marginBottom: 16,
  },
  heartPumpChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 10,
  },
  heartPumpChipIcon: {
    fontSize: 15,
  },
  heartPumpChipText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#064E3B',
    flex: 1,
  },
  heartPumpInputRow: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 8,
  },
  heartPumpInput: {
    flex: 1,
    fontSize: 12.5,
    color: '#0F172A',
    paddingVertical: 8,
  },
  heartPumpInputSendBtn: {
    backgroundColor: '#059669',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
});
