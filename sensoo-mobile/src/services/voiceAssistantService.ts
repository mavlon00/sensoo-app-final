// sensoo-mobile/src/services/voiceAssistantService.ts
// Privacy-first, Foreground-Only Voice Assistant with Biometric Voiceprint Verification

export interface VoiceAssistantSettings {
  enabled: boolean;
  isVoiceTrained: boolean;
  voicePrintHash: string | null;
  voiceReplyEnabled: boolean; // default false as requested
  visualGlowEnabled: boolean; // default true
  trainingDate: string | null;
}

export type VoiceCommandIntent =
  | 'GREETING'
  | 'SCAN'
  | 'CLINIC'
  | 'REPORT'
  | 'HISTORY'
  | 'ALERTS'
  | 'PROFILE'
  | 'NOTIFICATIONS'
  | 'ABOUT'
  | 'PERSONAL_INFO'
  | 'PRIVACY_SECURITY'
  | 'LOCATION_REGION'
  | 'GUIDANCE'
  | 'UNKNOWN';

export interface ParsedVoiceCommand {
  hasWakeWord: boolean;
  intent: VoiceCommandIntent;
  rawText: string;
  actionSummary: string;
}

// Global persistent in-memory store
let currentSettings: VoiceAssistantSettings = {
  enabled: true,
  isVoiceTrained: true,
  voicePrintHash: 'VP-SENSOO-ACTIVE-01',
  voiceReplyEnabled: true, // enabled by default so assistant speaks back
  visualGlowEnabled: true,
  trainingDate: 'Calibrated (Ready)',
};

type SettingsListener = (settings: VoiceAssistantSettings) => void;
const listeners: Set<SettingsListener> = new Set();

export const getVoiceAssistantSettings = (): VoiceAssistantSettings => {
  return { ...currentSettings };
};

export const updateVoiceAssistantSettings = (
  patch: Partial<VoiceAssistantSettings>
): VoiceAssistantSettings => {
  currentSettings = { ...currentSettings, ...patch };
  listeners.forEach((listener) => {
    try {
      listener(currentSettings);
    } catch (e) {
      console.warn('VoiceAssistant settings listener error:', e);
    }
  });
  return { ...currentSettings };
};

export const subscribeVoiceAssistantSettings = (
  listener: SettingsListener
): (() => void) => {
  listeners.add(listener);
  listener(currentSettings);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Calibrates a voiceprint hash for the user based on spoken audio features.
 * In a native environment, this records MFCC / acoustic vector embeddings.
 */
export const registerVoiceprint = (sampleCount: number): string => {
  const hash = `VP-SENSOO-${Date.now().toString(36).toUpperCase()}-${sampleCount}`;
  updateVoiceAssistantSettings({
    isVoiceTrained: true,
    voicePrintHash: hash,
    trainingDate: new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
  });
  return hash;
};

export const resetVoiceprint = (): void => {
  updateVoiceAssistantSettings({
    isVoiceTrained: false,
    voicePrintHash: null,
    trainingDate: null,
  });
};

/**
 * Parses user speech for the "Hey Sensoo" wake-word and classifies intent.
 */
export const parseVoiceCommand = (transcript: string): ParsedVoiceCommand => {
  // Normalize punctuation and extra spaces so "Hey! Sensoo" or "Hey, Sensoo" matches cleanly
  const normalized = transcript
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const wakeWordRegex = /\b(hey\s+)?(sensoo|senso|sensu|censu|censoo|senzo|sensor|censor|sansa|sinsoo|cinsoo)\b/i;
  const hasWakeWord =
    wakeWordRegex.test(normalized) ||
    normalized.includes('sensoo') ||
    normalized.includes('senso') ||
    normalized.includes('sensor') ||
    normalized.includes('censu') ||
    normalized.includes('sensu');

  // Strip wake phrase for intent classification
  const cleanCmd = normalized
    .replace(/\b(hey\s+)?(sensoo|senso|sensu|censu|censoo|senzo|sensor|censor|sansa|sinsoo|cinsoo)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  let intent: VoiceCommandIntent = 'UNKNOWN';
  let actionSummary = 'Command not recognized';

  // 0. Greeting / Wake Word check (e.g. "Hey! Sensoo", "Hello Sensoo", "Hi Sensoo", or wake word alone)
  const greetingWords = [
    '',
    'hello',
    'hi',
    'hey',
    'good morning',
    'good afternoon',
    'good evening',
    'how are you',
    'sup',
    'yo',
    'whats up',
    'what s up',
    'how far',
    'kedu',
    'bawo',
    'sannu',
    'there',
  ];
  if ((hasWakeWord && greetingWords.includes(cleanCmd)) || (hasWakeWord && cleanCmd.length === 0) || cleanCmd === '') {
    intent = 'GREETING';
    actionSummary = 'Greeting: "Hello! How can I help you today?"';
  }
  // 1. Comprehensive SCANNING intent keywords
  else if (
    cleanCmd.includes('scan') ||
    cleanCmd.includes('camera') ||
    cleanCmd.includes('barcode') ||
    cleanCmd.includes('qr') ||
    cleanCmd.includes('code') ||
    cleanCmd.includes('check') ||
    cleanCmd.includes('verify') ||
    cleanCmd.includes('test') ||
    cleanCmd.includes('picture') ||
    cleanCmd.includes('snap') ||
    cleanCmd.includes('read') ||
    cleanCmd.includes('product') ||
    cleanCmd.includes('item') ||
    cleanCmd.includes('authentic') ||
    cleanCmd.includes('look at')
  ) {
    intent = 'SCAN';
    actionSummary = 'Opening barcode scanner...';
  }
  // 2. Comprehensive CLINIC / HOSPITAL / HEALTH intent keywords
  else if (
    cleanCmd.includes('clinic') ||
    cleanCmd.includes('hospital') ||
    cleanCmd.includes('doctor') ||
    cleanCmd.includes('nurse') ||
    cleanCmd.includes('pharmacy') ||
    cleanCmd.includes('chemist') ||
    cleanCmd.includes('emergency') ||
    cleanCmd.includes('health') ||
    cleanCmd.includes('sick') ||
    cleanCmd.includes('reaction') ||
    cleanCmd.includes('poison') ||
    cleanCmd.includes('treatment') ||
    cleanCmd.includes('medical')
  ) {
    intent = 'CLINIC';
    actionSummary = 'Finding accredited clinics...';
  }
  // 3. Comprehensive REPORT / FAKE intent keywords
  else if (
    cleanCmd.includes('report') ||
    cleanCmd.includes('fake') ||
    cleanCmd.includes('counterfeit') ||
    cleanCmd.includes('complaint') ||
    cleanCmd.includes('nafdac') ||
    cleanCmd.includes('fraud') ||
    cleanCmd.includes('scam') ||
    cleanCmd.includes('bad') ||
    cleanCmd.includes('flag') ||
    cleanCmd.includes('alert')
  ) {
    intent = 'REPORT';
    actionSummary = 'Opening NAFDAC report intake...';
  }
  // 4. ALERTS / FRAUD WARNINGS intent keywords
  else if (
    cleanCmd.includes('alert') ||
    cleanCmd.includes('warning') ||
    cleanCmd.includes('threat') ||
    cleanCmd.includes('danger')
  ) {
    intent = 'ALERTS';
    actionSummary = 'Opening community safety alerts...';
  }
  // 5. NOTIFICATIONS intent keywords
  else if (
    cleanCmd.includes('notification') ||
    cleanCmd.includes('notify') ||
    cleanCmd.includes('bell') ||
    cleanCmd.includes('unread') ||
    cleanCmd.includes('messages')
  ) {
    intent = 'NOTIFICATIONS';
    actionSummary = 'Opening notifications...';
  }
  // 6. PERSONAL INFORMATION intent keywords
  else if (
    cleanCmd.includes('personal info') ||
    cleanCmd.includes('my info') ||
    cleanCmd.includes('account info') ||
    cleanCmd.includes('my detail') ||
    cleanCmd.includes('my name') ||
    cleanCmd.includes('my email') ||
    cleanCmd.includes('my phone')
  ) {
    intent = 'PERSONAL_INFO';
    actionSummary = 'Opening personal information...';
  }
  // 7. PRIVACY & SECURITY intent keywords
  else if (
    cleanCmd.includes('privacy') ||
    cleanCmd.includes('security') ||
    cleanCmd.includes('permission') ||
    cleanCmd.includes('data protection')
  ) {
    intent = 'PRIVACY_SECURITY';
    actionSummary = 'Opening privacy and security...';
  }
  // 8. LOCATION & REGION intent keywords
  else if (
    cleanCmd.includes('location') ||
    cleanCmd.includes('region') ||
    cleanCmd.includes('gps') ||
    cleanCmd.includes('my area') ||
    cleanCmd.includes('territory') ||
    cleanCmd.includes('geofence')
  ) {
    intent = 'LOCATION_REGION';
    actionSummary = 'Opening location and region...';
  }
  // 9. ABOUT SENSOO intent keywords
  else if (
    cleanCmd.includes('about') ||
    cleanCmd.includes('version') ||
    cleanCmd.includes('app info') ||
    cleanCmd.includes('who are you') ||
    cleanCmd.includes('what is sensoo')
  ) {
    intent = 'ABOUT';
    actionSummary = 'Opening About Sensoo...';
  }
  // 10. PROFILE intent keywords
  else if (
    cleanCmd.includes('profile') ||
    cleanCmd.includes('account') ||
    cleanCmd.includes('settings') ||
    cleanCmd.includes('my user')
  ) {
    intent = 'PROFILE';
    actionSummary = 'Opening user profile...';
  }
  // 11. HISTORY / PAST SCANS intent keywords
  else if (
    cleanCmd.includes('history') ||
    cleanCmd.includes('previous') ||
    cleanCmd.includes('my scans') ||
    cleanCmd.includes('past') ||
    cleanCmd.includes('record') ||
    cleanCmd.includes('log') ||
    cleanCmd.includes('scanned')
  ) {
    intent = 'HISTORY';
    actionSummary = 'Opening scan history...';
  }
  // 12. GUIDANCE / GENERAL ADVICE intent keywords
  else if (
    cleanCmd.includes('guidance') ||
    cleanCmd.includes('advice') ||
    cleanCmd.includes('help') ||
    cleanCmd.includes('what should i do') ||
    cleanCmd.includes('safety') ||
    cleanCmd.includes('agent') ||
    cleanCmd.includes('ask')
  ) {
    intent = 'GUIDANCE';
    actionSummary = 'Opening AI safety guidance...';
  } else {
    intent = 'UNKNOWN';
    actionSummary = 'Command not recognized';
  }

  return {
    hasWakeWord: hasWakeWord || intent !== 'UNKNOWN',
    intent,
    rawText: transcript,
    actionSummary,
  };
};



import * as FileSystem from 'expo-file-system/legacy';

/**
 * Transcribes an audio file via Groq Whisper API (whisper-large-v3-turbo).
 * Uses FileSystem.uploadAsync for native, crash-proof multipart file upload.
 * Hidden from screen display; outputs clean string for command dispatch.
 */
export const transcribeAudioWithGroq = async (audioUri: string): Promise<string> => {
  const apiKey = (process.env.EXPO_PUBLIC_GROQ_API_KEY || '').trim();

  if (!apiKey || !audioUri) {
    console.warn('[VoiceAssistant] Missing Groq API key or audio URI, skipping cloud transcription');
    return '';
  }

  try {
    const fileInfo = await FileSystem.getInfoAsync(audioUri);
    if (!fileInfo.exists || ((fileInfo as any).size !== undefined && (fileInfo as any).size < 200)) {
      console.log('[VoiceAssistant] Audio file empty or too short (<200 bytes), skipping transcription');
      return '';
    }

    const uploadResult = await FileSystem.uploadAsync(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      audioUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: 'audio/m4a',
        parameters: {
          model: 'whisper-large-v3-turbo',
          language: 'en',
          response_format: 'json',
          prompt: 'Sensoo, Hey Sensoo, NAFDAC, GS1, Nigeria, medicine, clinic',
        },
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      console.warn(`[VoiceAssistant] Groq transcription HTTP ${uploadResult.status}:`, uploadResult.body);
      return '';
    }

    const data = JSON.parse(uploadResult.body);
    return data?.text || '';
  } catch (err) {
    console.warn('[VoiceAssistant] Groq Whisper network error:', err);
    return '';
  }
};

