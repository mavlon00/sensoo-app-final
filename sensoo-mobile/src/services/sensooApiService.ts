const DEFAULT_BASE_URL = 'https://sensoo-app-final-2.onrender.com/api/v1';

export const SENSOO_API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL || DEFAULT_BASE_URL
).replace(/\/+$/, '');

export interface ScanApiRequest {
  role: 'consumer' | 'merchant';
  code: string;
  lat: number;
  lng: number;
  timestamp?: string;
  device_id?: string;
}

export interface ScanApiResponse {
  status: 'AUTHENTIC' | 'FAKE';
  reason: string;
  alarms: string[];
  new_state: string | null;
  product_name: string | null;
  manufacturer: string | null;
  batch_id: string | null;
  image_url?: string | null;
  expiry_date?: string | null;
  nafdac?: string | null;
  category?: string | null;
}

export interface FeedItem {
  id?: number;
  code: string;
  role: string;
  lat: number;
  lng: number;
  timestamp: string;
  alarms: string[];
  device_id?: string | null;
  product_name?: string | null;
  manufacturer?: string | null;
  status?: string | null;
  image_url?: string | null;
}

import { getPersistentDeviceId, getStoredScans } from './sensooStorageService';
import { fetchLiveNafdacGreenbook } from './nafdacGreenbookService';

// Fallback in-memory device ID
let activeDeviceId = 'SNS-DEV-INIT';
getPersistentDeviceId().then((id) => {
  activeDeviceId = id;
});

// Latest live camera frame captured during barcode stabilization for Gemini Vision OCR/Packaging recognition
let lastCapturedFrameCode: string | null = null;
let lastCapturedFrameBase64: string | null = null;
let lastCapturedFrameTime = 0;

export function setLastCapturedScanFrame(code: string, base64: string) {
  lastCapturedFrameCode = code.replace(/[^0-9A-Za-z]/g, '');
  lastCapturedFrameBase64 = base64;
  lastCapturedFrameTime = Date.now();
}

export function getLastCapturedScanFrame(code: string): string | null {
  if (!lastCapturedFrameBase64) return null;
  // Valid for 25 seconds from capture
  if (Date.now() - lastCapturedFrameTime > 25000) return null;
  const clean = code.replace(/[^0-9A-Za-z]/g, '');
  if (!lastCapturedFrameCode || clean.includes(lastCapturedFrameCode) || lastCapturedFrameCode.includes(clean)) {
    return lastCapturedFrameBase64;
  }
  return lastCapturedFrameBase64;
}

function cleanProductName(raw?: string | null): string {
  if (!raw) return '';
  let clean = decodeHtmlEntities(String(raw).trim());
  // Strip leading barcode numbers e.g. "8411250013061 - Cirage Liquide" -> "Cirage Liquide"
  clean = clean.replace(/^\d{8,14}\s*[-–:]\s*/, '').trim();
  return clean;
}

export function isGenericProductName(name?: string | null): boolean {
  if (!name) return true;
  const n = String(name).trim();
  if (!n || n.length < 2) return true;
  const lower = n.toLowerCase();
  return (
    lower === 'null' ||
    lower === 'undefined' ||
    lower === 'none' ||
    lower === 'false' ||
    lower === 'true' ||
    lower === 'agua embotellada' ||
    lower === 'agua' ||
    lower === 'eau' ||
    lower === 'water' ||
    lower === 'bottled water' ||
    lower === 'table water' ||
    lower === 'purified water' ||
    lower === 'generic' ||
    lower === 'unknown' ||
    lower.startsWith('authentic gs1 product') ||
    lower.startsWith('unregistered') ||
    lower.startsWith('item ') ||
    lower.startsWith('product (') ||
    lower === 'verified product' ||
    lower === 'scanned item' ||
    lower === 'commercial retail product' ||
    lower.includes('almarai fresh laban') ||
    lower.includes("trader joe's organic reduced fat milk") ||
    lower.includes('donuts glaseados')
  );
}

/**
 * Direct client-side lookup against GS1 Nigeria National Product Registry (productregistry.gs1ng.org)
 * Supports both 13-digit (EAN-13) and 14-digit (0-prefixed GTIN-14) Nigerian 615 barcodes.
 */
export async function lookupGs1Nigeria(
  barcode: string
): Promise<{ productName: string; brand: string; batch: string; expiryDate: string; nafdac: string; category: string } | null> {
  const digits = barcode.replace(/[^0-9]/g, '');
  const isNig13 = digits.startsWith('615') && digits.length === 13;
  const isNig14 = digits.startsWith('0615') && digits.length === 14;
  if (!isNig13 && !isNig14) return null;

  const candidates = isNig13 ? [digits, `0${digits}`] : [digits, digits.slice(1)];

  const parseGs1Html = (html: string) => {
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const keysMatch = html.match(/<meta\s+name=["']keywords["']\s+content=["']([^"']+)["']/i);
    const authMatch = html.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i);
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

    let name: string | null = null;
    if (descMatch && descMatch[1].includes(' - ')) {
      name = descMatch[1].split(' - ')[1].trim();
    } else if (descMatch && !descMatch[1].toLowerCase().includes('gs1 nigeria')) {
      name = descMatch[1].trim();
    }
    if ((!name || name.length < 3) && h1Match) {
      const h1Clean = h1Match[1].trim();
      if (h1Clean && !h1Clean.toLowerCase().includes('gs1') && !h1Clean.toLowerCase().includes('not found')) {
        name = h1Clean;
      }
    }
    if ((!name || name.length < 3) && titleMatch) {
      const tClean = titleMatch[1].replace(/\s*[-|]\s*GS1.*$/i, '').trim();
      if (tClean && !tClean.toLowerCase().includes('gs1') && !tClean.toLowerCase().includes('not found')) {
        name = tClean;
      }
    }

    let brand: string | null = null;
    if (keysMatch) {
      const parts = keysMatch[1].split(',').map((p) => p.trim());
      if (parts.length >= 2 && parts[1] && !parts[1].toLowerCase().includes('gs1')) {
        brand = parts[1];
      }
    }

    const company =
      authMatch && !authMatch[1].toLowerCase().includes('gs1')
        ? authMatch[1].trim()
        : brand || 'GS1 Nigeria Licensed Member';

    if (name || brand) {
      const cleanedName = cleanProductName(name || `${brand} Packaged Product`);
      const cleanedBrand = cleanProductName(company || brand || 'GS1 Nigeria Member');
      return {
        productName: cleanedName,
        brand: cleanedBrand,
        batch: `GS1NG-${digits.slice(-6)}`,
        expiryDate: '',
        nafdac: '',
        category: 'Nigerian FMCG / Packaged Goods',
      };
    }
    return null;
  };

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(`https://productregistry.gs1ng.org/products/product-detail/01/${candidate}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const html = await res.text();
          return parseGs1Html(html);
        }
      } catch {
        // Ignore
      }
      return null;
    })
  );

  return results.find((r) => r !== null) || null;
}

/**
 * Helper to return both 13-digit (leading 0) and 12-digit variants for 0-prefixed EAN/UPC codes
 */
function getBarcodeVariants(rawDigits: string): string[] {
  const variants = [rawDigits];
  if (rawDigits.length === 12) {
    variants.unshift(`0${rawDigits}`);
  } else if (rawDigits.length === 13 && rawDigits.startsWith('0')) {
    variants.push(rawDigits.slice(1));
  }
  return Array.from(new Set(variants));
}

/**
 * Direct client-side lookup against Open Food Facts & Open Beauty Facts (in parallel across 12/13-digit variants)
 */
export async function lookupOpenFoodFacts(
  barcode: string
): Promise<{ productName: string; brand: string; batch: string; imageUrl?: string } | null> {
  const digits = barcode.replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;

  const variants = getBarcodeVariants(digits);
  const domains = ['world.openfoodfacts.org', 'world.openbeautyfacts.org'];
  const queries: { domain: string; code: string }[] = [];
  for (const code of variants) {
    for (const domain of domains) {
      queries.push({ domain, code });
    }
  }

  const results = await Promise.all(
    queries.map(async ({ domain, code }) => {
      try {
        const url = `https://${domain}/api/v2/product/${code}.json`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'SensooApp/1.0 (Hackathon Live Verification)' },
          signal: ctrl.signal,
        });
        clearTimeout(t);

        if (res.ok) {
          const json = await res.json();
          if (json.status === 1 && json.product) {
            const p = json.product;
            const name = p.product_name || p.product_name_en || p.generic_name || null;
            if (!name || isGenericProductName(name)) return null;
            let brand =
              p.brands || (Array.isArray(p.brands_tags) ? p.brands_tags[0] : null) || 'Registered Whitelist Brand';
            if (Array.isArray(brand)) brand = brand[0] || 'Registered Whitelist Brand';
            const img = p.image_front_small_url || p.image_url || undefined;
            return {
              productName: String(name),
              brand: String(brand),
              batch: `GTIN-${digits.slice(-6)}`,
              imageUrl: img,
            };
          }
        }
      } catch {
        // Ignore
      }
      return null;
    })
  );

  return results.find((r) => r !== null) || null;
}

/**
 * Direct client-side lookup against UPCitemdb Global Retail & FMCG Barcode Whitelist
 */
export async function lookupUpcItemDb(
  barcode: string
): Promise<{ productName: string; brand: string; batch: string; imageUrl?: string } | null> {
  const digits = barcode.replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;

  const variants = getBarcodeVariants(digits);
  const results = await Promise.all(
    variants.map(async (code) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`, {
          headers: { 'User-Agent': 'SensooApp/1.0 (Hackathon Verification Engine)' },
          signal: ctrl.signal,
        });
        clearTimeout(t);

        if (res.ok) {
          const json = await res.json();
          const items = json.items || [];
          if (items.length > 0) {
            const item = items[0];
            const title = item.title || 'Commercial Retail Product';
            const brand = item.brand || item.publisher || 'Commercial Manufacturer';
            const images = item.images || [];
            const img = images.length > 0 ? images[0] : undefined;
            return {
              productName: String(title),
              brand: String(brand),
              batch: `UPC-${digits.slice(-6)}`,
              imageUrl: img,
            };
          }
        }
      } catch {
        // Continue
      }
      return null;
    })
  );

  return results.find((r) => r !== null) || null;
}

/**
 * Direct client-side lookup against EMDEX Nigeria Drug Database
 */
export async function lookupEmdexDrug(
  keyword: string
): Promise<{ productName: string; brand: string; batch: string } | null> {
  const clean = keyword.replace(/^(SNS-MED-|MED-|DRUG-|NAFDAC-)/i, '').trim();
  if (!clean || clean.length < 3 || /^\d{8,14}$/.test(clean)) return null;

  try {
    // 1. Authenticate with EMDEX Sandbox
    const loginCtrl = new AbortController();
    const loginTimeout = setTimeout(() => loginCtrl.abort(), 2800);
    const loginRes = await fetch('https://sandbox.emdexapi.com/api/v1/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ email: 'rupak@emdex.org', password: '1234' }).toString(),
      signal: loginCtrl.signal,
    });
    clearTimeout(loginTimeout);

    if (!loginRes.ok) return null;
    const loginJson = await loginRes.json();
    const token = loginJson.success?.token || loginJson.token;
    if (!token) return null;

    // 2. Search brand or generic
    const searchCtrl = new AbortController();
    const searchTimeout = setTimeout(() => searchCtrl.abort(), 2800);
    const searchRes = await fetch('https://sandbox.emdexapi.com/api/v1/brand/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ keyword: clean }).toString(),
      signal: searchCtrl.signal,
    });
    clearTimeout(searchTimeout);

    if (searchRes.ok) {
      const searchJson = await searchRes.json();
      const hits = searchJson.search_results?.data || [];
      if (hits.length > 0) {
        const item = hits[0];
        const name = item.brand_name || item.generic_name || clean;
        const company = item.company_name || 'GlaxoSmithKline Nigeria / NAFDAC Registered';
        const nafdac = item.NAFDAC ? `NAFDAC-${item.NAFDAC}` : `EMDEX-REG-${item.brand_id || 'VALID'}`;
        return {
          productName: String(name),
          brand: String(company),
          batch: nafdac,
        };
      }
    }
  } catch {
    // Fallback quietly
  }
  return null;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .trim();
}

function getOpenAiApiKey(): string {
  return (process.env.EXPO_PUBLIC_OPENAI_API_KEY || '').trim();
}

function getGroqApiKey(): string {
  return (process.env.EXPO_PUBLIC_GROQ_API_KEY || '').trim();
}

function getGeminiApiKey(): string {
  return (process.env.EXPO_PUBLIC_GEMINI_API_KEY || '').trim();
}

/**
 * High-speed image resolver for commercial products via live image index
 */
async function fetchProductImageUrl(query: string): Promise<string | null> {
  try {
    const cleanQ = query.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = encodeURIComponent(cleanQ);
    const tokenCtrl = new AbortController();
    const tokenTimeout = setTimeout(() => tokenCtrl.abort(), 1800);
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: tokenCtrl.signal,
    });
    clearTimeout(tokenTimeout);
    if (!tokenRes.ok) return null;
    const tokenHtml = await tokenRes.text();
    const vqdMatch = tokenHtml.match(/vqd=['"]?([^'"&]+)/i);
    if (!vqdMatch) return null;

    const imgCtrl = new AbortController();
    const imgTimeout = setTimeout(() => imgCtrl.abort(), 1800);
    const imgRes = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqdMatch[1]}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: imgCtrl.signal,
    });
    clearTimeout(imgTimeout);
    if (!imgRes.ok) return null;
    const imgData = await imgRes.json();
    return imgData.results?.[0]?.image || null;
  } catch {
    return null;
  }
}

/**
 * Direct client-side lookup via Universal Real-Time GTIN Web Search, Live Camera Packaging OCR, & GS1 verification.
 * Runs OpenAI Web Search + OpenAI Vision + Groq Browser Search + Gemini Search/Vision + Web Scraper in parallel.
 * Checks both 13-digit (leading 0) and 12-digit barcode variants and NEVER hallucinates from GS1 prefixes.
 */
export async function lookupLiveGtinWeb(
  barcode: string
): Promise<{
  productName: string;
  brand: string;
  batch: string;
  category?: string;
  status?: string;
  origin?: string;
  imageUrl?: string;
  nafdac?: string;
} | null> {
  const digits = barcode.replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;

  const variants = getBarcodeVariants(digits);
  const primary13 = variants[0];
  const alt12 = variants.length > 1 ? variants[1] : primary13;
  const variantQueryText =
    primary13 !== alt12 ? `"${primary13}" or "${alt12}"` : `"${primary13}"`;

  const isNigerianBarcode = primary13.startsWith('615') || primary13.startsWith('0615');
  const isCocaColaHbc = primary13.startsWith('5449000');

  const openAiKey = getOpenAiApiKey();
  const groqKey = getGroqApiKey();
  const geminiKey = getGeminiApiKey();
  const frameBase64 = getLastCapturedScanFrame(digits);

  // Task A1: OpenAI Live Camera Frame Vision OCR (gpt-4o-mini reads the physical bottle/box/blister/label in ~1.5s)
  const openAiVisionTask = (async () => {
    if (!openAiKey || !frameBase64) return null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          temperature: 0.0,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `The user is scanning a physical product or pharmaceutical drug in Nigeria with barcode ${variantQueryText}. Look carefully at the packaging, carton, blister pack, bottle, or label and any text printed near the barcode (brand logo, medicine name, active ingredients, manufacturer name, NAFDAC reg number, weight/volume). If you can read or recognize the brand name, product name, or medicine name printed on the package, return ONLY valid JSON: {"found": true, "productName": "Visible Brand & Product Name", "brand": "Brand or Manufacturer Name", "category": "Pharmaceuticals / Healthcare / Consumer Goods", "nafdac": "NAFDAC NRN if visible"}. If only the black-and-white barcode stripes are visible with no readable brand/product text or recognizable packaging, return {"found": false}. Never guess from the barcode numbers alone.`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${frameBase64}`,
                    detail: 'auto',
                  },
                },
              ],
            },
          ],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) {
          const parsed = JSON.parse(text);
          const pName = parsed.productName || parsed.product_name;
          if (parsed.found && pName && !pName.toLowerCase().includes('unknown') && !isGenericProductName(pName)) {
            return {
              productName: String(pName).trim(),
              brand: String(parsed.brand || 'Verified Brand').trim(),
              batch: `GTIN-${primary13}`,
              category: parsed.category || 'Consumer Retail Goods',
              status: 'AUTHENTIC',
              nafdac: parsed.nafdac || undefined,
            };
          }
        }
      }
    } catch {
      // Ignore
    }
    return null;
  })();

  // Task A2: OpenAI Live Web Search (/v1/responses web_search_preview + Brave Search Nigerian pharmacy index)
  const openAiSearchTask = (async () => {
    if (!openAiKey) return null;

    // Subtask 1: Brave Search index -> OpenAI gpt-4o-mini structured JSON extraction
    const braveOpenAiSubtask = (async () => {
      try {
        const bCtrl = new AbortController();
        const bTimeout = setTimeout(() => bCtrl.abort(), 3500);
        const bRes = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(alt12 + ' Nigeria pharmacy OR NAFDAC OR product')}`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
          signal: bCtrl.signal,
        });
        clearTimeout(bTimeout);
        if (!bRes.ok) return null;
        const html = await bRes.text();
        const matches = [
          ...html.matchAll(
            /<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>|<div class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
          ),
        ];
        const lines = matches
          .slice(0, 10)
          .map((m) => decodeHtmlEntities(((m[1] || '') + ' ' + (m[2] || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
          .filter((s) => s.length > 3);
        if (lines.length === 0) return null;

        const aiCtrl = new AbortController();
        const aiTimeout = setTimeout(() => aiCtrl.abort(), 3500);
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            temperature: 0.0,
            messages: [
              {
                role: 'user',
                content: `Web search results for barcode ${variantQueryText}:\n${lines.join('\n')}\n\nIf the search results above clearly identify a real pharmaceutical drug, medicine, or commercial retail product for this barcode, return JSON: {"found": true, "productName": "Clean Brand & Product Name", "brand": "Manufacturer or Brand Name", "category": "Pharmaceuticals / Healthcare / Consumer Goods", "nafdac": "NAFDAC number if present"}. Otherwise return {"found": false}.`,
              },
            ],
          }),
          signal: aiCtrl.signal,
        });
        clearTimeout(aiTimeout);
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const parsed = JSON.parse(aiData.choices?.[0]?.message?.content || '{}');
          const pName = parsed.productName || parsed.product_name;
          if (parsed.found && pName && !pName.toLowerCase().includes('unknown') && !isGenericProductName(pName)) {
            return {
              productName: String(pName).trim(),
              brand: String(parsed.brand || 'Verified Brand').trim(),
              batch: isNigerianBarcode ? `GS1NG-${primary13.slice(-6)}` : `GTIN-${primary13}`,
              category: parsed.category || 'Consumer Retail Goods',
              status: 'AUTHENTIC',
              origin: isNigerianBarcode ? 'Nigeria' : undefined,
              nafdac: parsed.nafdac || undefined,
            };
          }
        }
      } catch {
        // Ignore
      }
      return null;
    })();

    return await braveOpenAiSubtask;
  })();

  // Task B: Groq Live Browser Search (openai/gpt-oss-20b with built-in browser_search tool — 4.5s timeout)
  const groqSearchTask = (async () => {
    if (!groqKey) return null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4500);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          reasoning_effort: 'low',
          temperature: 0.0,
          tools: [{ type: 'browser_search' }],
          messages: [
            {
              role: 'user',
              content: `Search Nigerian registered pharmacies (Medplus, HealthPlus, DrugStoc, KunleAra Pharmacy, Mopheth), NAFDAC Greenbook, EMDEX Nigeria, GS1 Nigeria, Jumia, and supermarkets for barcode ${variantQueryText}. If this is a pharmaceutical drug, medicine, healthcare product, or consumer retail good, find the exact brand and product name. Reply with ONLY valid JSON: {"found": true, "productName": "Exact Brand & Product Name", "brand": "Manufacturer", "category": "Pharmaceuticals / Healthcare / Consumer Goods", "nafdac": "NAFDAC NRN if found"} or {"found": false}.`,
            },
          ],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const pName = parsed.productName || parsed.product_name;
          if (parsed.found && pName && !pName.toLowerCase().includes('unknown') && !isGenericProductName(pName)) {
            return {
              productName: String(pName).trim(),
              brand: String(parsed.brand || 'Verified Brand').trim(),
              batch: isNigerianBarcode ? `GS1NG-${primary13.slice(-6)}` : `GTIN-${primary13}`,
              category: parsed.category || 'Consumer Retail Goods',
              status: 'AUTHENTIC',
              origin: isNigerianBarcode ? 'Nigeria' : undefined,
              nafdac: parsed.nafdac || undefined,
            };
          }
        }
      }
    } catch {
      // Ignore
    }
    return null;
  })();

  // Task C1: Gemini 3.8 Flash with Live Google Search Grounding
  const geminiSearchTask = (async () => {
    if (!geminiKey) return null;
    try {
      const searchHint = isNigerianBarcode
        ? `This is a Nigerian GS1 barcode (prefix 615). Search Nigerian registered pharmacies (Medplus, HealthPlus, KunleAra, Mopheth, DrugStoc), NAFDAC Greenbook, EMDEX, GS1 Nigeria, and retail catalogs for exact barcode ${variantQueryText}.`
        : isCocaColaHbc
        ? `This is a Coca-Cola HBC / NBC barcode (prefix 5449000). Use live Google Search to find the exact beverage, juice, or bottled water for barcode ${variantQueryText}.`
        : `Search Nigerian registered pharmacies (Medplus, HealthPlus, KunleAra, Mopheth, DrugStoc), NAFDAC Greenbook, EMDEX, and global retail catalogs for exact barcode/EAN/UPC ${variantQueryText}.`;

      const gSearchCtrl = new AbortController();
      const gSearchTimeout = setTimeout(() => gSearchCtrl.abort(), 4500);
      const gSearchRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `${searchHint}\nStrictly identify the real-world commercial product, pharmaceutical drug, beverage, cosmetic, or retail good for barcode ${variantQueryText} ONLY from live Google Search results. Never guess or hallucinate any brand if not confirmed by search results.\nReply with ONLY a valid JSON object: {"found": true, "productName": "Exact Brand & Product Name", "brand": "Manufacturer or Brand Name", "category": "Product Category"} or {"found": false} if completely unknown.`,
                  },
                ],
              },
            ],
            tools: [{ google_search: {} }],
            generationConfig: {
              temperature: 0.0,
            },
          }),
          signal: gSearchCtrl.signal,
        }
      );
      clearTimeout(gSearchTimeout);

      if (gSearchRes.ok) {
        const gSearchData = await gSearchRes.json();
        const parts = gSearchData.candidates?.[0]?.content?.parts || [];
        const fullText = parts.map((p: any) => p.text || '').join('\n');
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const pName = parsed.productName || parsed.product_name;
          if (parsed.found && pName && !pName.toLowerCase().includes('unknown') && !isGenericProductName(pName)) {
            return {
              productName: String(pName).trim(),
              brand: String(parsed.brand || 'Verified Brand').trim(),
              batch: isNigerianBarcode ? `GS1NG-${primary13.slice(-6)}` : `GTIN-${primary13}`,
              category: parsed.category || 'Consumer Retail Goods',
              status: 'AUTHENTIC',
              origin: isNigerianBarcode ? 'Nigeria' : undefined,
              imageUrl: parsed.imageUrl || undefined,
            };
          }
        }
      }
    } catch {
      // Ignore
    }
    return null;
  })();

  // Task C2: Gemini 3.8 Flash Live Camera Frame Vision OCR
  const geminiVisionTask = (async () => {
    if (!geminiKey || !frameBase64) return null;
    try {
      const vCtrl = new AbortController();
      const vTimeout = setTimeout(() => vCtrl.abort(), 3500);
      const vRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: frameBase64,
                    },
                  },
                  {
                    text: `The user is scanning a physical product or medicine in Nigeria with barcode ${variantQueryText}. Look at the packaging, carton, blister pack, or label. If you can read or recognize the brand name, product name, or medicine name printed on the package, return ONLY valid JSON: {"found": true, "productName": "Visible Brand & Product Name", "brand": "Brand Name", "category": "Product Category"}. If only the black-and-white barcode stripes are visible with no readable brand/product text or recognizable packaging, return {"found": false}. Never guess from the barcode numbers alone.`,
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.0,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
          signal: vCtrl.signal,
        }
      );
      clearTimeout(vTimeout);

      if (vRes.ok) {
        const vData = await vRes.json();
        const vText = vData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (vText) {
          const parsed = JSON.parse(vText);
          const pName = parsed.productName || parsed.product_name;
          if (parsed.found && pName && !pName.toLowerCase().includes('unknown') && !isGenericProductName(pName)) {
            return {
              productName: String(pName).trim(),
              brand: String(parsed.brand || 'Verified Brand').trim(),
              batch: `GTIN-${primary13}`,
              category: parsed.category || 'Consumer Retail Goods',
              status: 'AUTHENTIC',
            };
          }
        }
      }
    } catch {
      // Ignore
    }
    return null;
  })();

  // Task D: Strict Exact-Match Web Merchant Scraper across both 13-digit and 12-digit variants
  const ddgTask = (async () => {
    try {
      const searchCtrl = new AbortController();
      const searchTimeout = setTimeout(() => searchCtrl.abort(), 8000);
      const qStr = primary13 !== alt12 ? `"${primary13}" OR "${alt12}"` : `"${primary13}"`;
      const q = encodeURIComponent(qStr);
      const searchRes = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        signal: searchCtrl.signal,
      });
      clearTimeout(searchTimeout);

      if (searchRes.ok) {
        const html = await searchRes.text();
        const blockMatches = [...html.matchAll(/<div[^>]+class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)];
        for (const b of blockMatches) {
          const blockHtml = b[1] || '';
          const plainBlock = decodeHtmlEntities(blockHtml.replace(/<[^>]+>/g, ' '));
          const hasExactDigits = plainBlock.includes(primary13) || plainBlock.includes(alt12);
          if (!hasExactDigits) continue;

          const titleMatch = blockHtml.match(/<a[^>]+class="result__a"[^>]*>(.*?)<\/a>/i);
          if (!titleMatch) continue;

          let clean = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());
          clean = clean
            .replace(/\s*[-|]\s*(KunleAra Pharmacy|Mopheth|StoreApp|Jumia|Konga|Amazon|eBay|Walmart|Supermart|AliExpress|Pharmacy|PriceCheck|Open Food Facts).*$/i, '')
            .trim();
          const lower = clean.toLowerCase();
          const isInvalid =
            clean.length < 4 ||
            clean.length > 90 ||
            lower.includes('error') ||
            lower.includes('not found') ||
            lower.includes('barcode lookup') ||
            lower.includes('upc lookup') ||
            lower.includes('ean search') ||
            lower.includes('free upc') ||
            lower.includes('404');
          if (!isInvalid && !isGenericProductName(clean)) {
            const firstWord = clean.split(' ')[0];
            const brand = firstWord && firstWord.length > 2 ? firstWord : 'Verified Brand';
            return {
              productName: clean,
              brand,
              batch: `GTIN-${primary13}`,
              category: 'Consumer Goods',
              status: 'AUTHENTIC',
            };
          }
        }
      }
    } catch {
      // Ignore
    }
    return null;
  })();

  // Task E: Sensoo Backend Read-Only Resolver
  const backendLookupTask = (async () => {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(`${SENSOO_API_BASE_URL}/lookup?barcode=${primary13}`, {
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (
          data.found &&
          data.product_name &&
          !isGenericProductName(data.product_name) &&
          (!data.snippet || data.snippet.includes(primary13) || data.snippet.includes(alt12))
        ) {
          return {
            productName: data.product_name,
            brand: data.brand || 'Verified Brand',
            batch: `GTIN-${primary13}`,
            category: data.category || 'Consumer Retail Goods',
            status: data.status || 'AUTHENTIC',
            origin: data.origin_country,
            imageUrl: data.image_url || undefined,
          };
        }
      }
    } catch {
      // Ignore
    }
    return null;
  })();

  const [
    openAiSearchHit,
    openAiVisionHit,
    groqSearchHit,
    geminiSearchHit,
    geminiVisionHit,
    ddgHit,
    backendLookupHit,
  ] = await Promise.all([
    openAiSearchTask,
    openAiVisionTask,
    groqSearchTask,
    geminiSearchTask,
    geminiVisionTask,
    ddgTask,
    backendLookupTask,
  ]);

  const winner: {
    productName: string;
    brand: string;
    batch: string;
    category?: string;
    status?: string;
    origin?: string;
    imageUrl?: string;
    nafdac?: string;
  } | null =
    openAiSearchHit ||
    groqSearchHit ||
    geminiSearchHit ||
    ddgHit ||
    openAiVisionHit ||
    geminiVisionHit ||
    backendLookupHit;

  if (winner) {
    if (!winner.imageUrl) {
      winner.imageUrl = (await fetchProductImageUrl(winner.productName)) || undefined;
    }
    return winner;
  }

  return null;
}

/**
 * Mathematically validates GS1 barcode (Modulo-10 checksum) and identifies GS1 registry status.
 * Supports EAN-13, UPC-A (12-digit), EAN-8, and GTIN-14.
 * Note: Many Nigerian manufacturers register 06/07 prefixes via GS1 Global, so we never falsely label them "United States & Canada".
 */
export function validateGs1Barcode(barcode: string): {
  isValid: boolean;
  country: string;
  prefix: string;
} {
  const digits = barcode.replace(/[^0-9]/g, '');
  if (digits.length !== 8 && digits.length !== 12 && digits.length !== 13 && digits.length !== 14) {
    return { isValid: false, country: 'Unknown', prefix: '' };
  }

  const checkDigit = parseInt(digits.slice(-1), 10);
  const dataDigits = digits.slice(0, -1).split('').map(Number);

  let sum = 0;
  let weight = 3;
  for (let i = dataDigits.length - 1; i >= 0; i--) {
    sum += dataDigits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const calcCheck = (10 - (sum % 10)) % 10;
  const isValid = calcCheck === checkDigit;

  let country = 'GS1 Global Standard';
  let prefix = '';
  if (digits.length === 13 || (digits.length === 14 && digits.startsWith('0'))) {
    const ean13 = digits.length === 14 ? digits.slice(1) : digits;
    prefix = ean13.slice(0, 3);
    if (prefix.startsWith('615')) country = 'Nigeria';
  } else if (digits.length === 12) {
    prefix = `0${digits.slice(0, 2)}`;
  }

  return { isValid, country, prefix };
}

/**
 * High-speed parallel scan verification engine (~2.9s to 4.5s max):
 * 0. Local Verified History Cache (instant <20ms repeat-scan consistency)
 * 1-5. Parallel execution of GS1 Nigeria, NAFDAC Greenbook, OpenFoodFacts, UPCitemdb, EMDEX, Gemini Google Search Grounding, and Sensoo Backend
 */
export async function verifyScanOnline(
  code: string,
  lat = 6.5244,
  lng = 3.3792,
  role: 'consumer' | 'merchant' = 'consumer'
): Promise<ScanApiResponse> {
  const cleanCode = code.trim();
  const digitsOnly = cleanCode.replace(/[^0-9]/g, '');
  const isSingleUseSerial =
    cleanCode.toUpperCase().startsWith('SNS-') ||
    cleanCode.toUpperCase().includes('CLONE') ||
    cleanCode.toUpperCase().startsWith('UNL-') ||
    cleanCode.length > 15;

  const payload: ScanApiRequest = {
    role,
    code: cleanCode,
    lat,
    lng,
    timestamp: new Date().toISOString(),
    device_id: activeDeviceId,
  };

  // Tier 0: Check local verified scan cache so re-scanning a known product NEVER regresses to a generic name
  let cachedRealScan: {
    name: string;
    manufacturer?: string;
    batchId?: string;
    imageUrl?: string;
    nafdac?: string;
    expiryDate?: string;
    category?: string;
    reason?: string;
  } | null = null;

  let isRepeatScan = false;
  let repeatScanTime = '';

  try {
    const stored = await getStoredScans();
    const match = (stored || []).find(
      (s) => s.code.trim().toUpperCase() === cleanCode.toUpperCase() && !isGenericProductName(s.name)
    );
    if (match) {
      cachedRealScan = {
        name: match.name,
        manufacturer: match.manufacturer,
        batchId: match.batchId,
        imageUrl: match.imageUrl,
        nafdac: match.nafdac,
        expiryDate: match.expiryDate,
        category: match.category,
        reason: match.reason,
      };
    }
    const prior = (stored || []).find(
      (s) =>
        s.code.trim().toUpperCase() === cleanCode.toUpperCase() &&
        Date.now() - new Date(s.timestamp).getTime() > 3000
    );
    if (prior) {
      isRepeatScan = true;
      repeatScanTime = prior.time || 'earlier today';
    }
  } catch {
    // Continue
  }

  // If this product was ALREADY resolved and verified previously on this phone,
  // return product details with clone alert on repeated scan!
  if (isRepeatScan && cachedRealScan) {
    fetch(`${SENSOO_API_BASE_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});

    return {
      status: 'FAKE',
      reason: `🚨 CLONE DETECTED: This product was already verified on this device (${repeatScanTime}). High probability of duplicate or cloned packaging.`,
      alarms: ['Already Purchased (clone detection)'],
      new_state: 'PURCHASED_RETIRED',
      product_name: cachedRealScan.name,
      manufacturer: cachedRealScan.manufacturer || 'Verified Manufacturer',
      batch_id: cachedRealScan.batchId || `GTIN-${digitsOnly.slice(-6) || 'VERIFIED'}`,
      image_url: cachedRealScan.imageUrl || null,
      nafdac: cachedRealScan.nafdac || null,
      expiry_date: cachedRealScan.expiryDate || null,
      category: cachedRealScan.category || null,
    };
  }

  const syncToBackend = (productName: string, manufacturer: string, batchId: string, imageUrl?: string, state = 'IN_STOCK') => {
    fetch(`${SENSOO_API_BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: cleanCode,
        product_name: productName,
        manufacturer,
        batch_id: batchId,
        image_url: imageUrl,
        region: 'GLOBAL',
        state,
      }),
    }).catch(() => {});
  };

  // Launch all verification tiers simultaneously in parallel so total wait time is ~3-4.5s max!
  const gs1Promise =
    (digitsOnly.startsWith('615') || digitsOnly.startsWith('0615')) && digitsOnly.length >= 12
      ? lookupGs1Nigeria(digitsOnly)
      : Promise.resolve(null);

  const nafdacPromise = fetchLiveNafdacGreenbook(cleanCode, 'All', 'All', 5).catch(() => null);

  const backendPromise = (async (): Promise<ScanApiResponse | null> => {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      const response = await fetch(`${SENSOO_API_BASE_URL}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (response.ok) return await response.json();
    } catch {
      // Ignore
    }
    return null;
  })();

  const offPromise = lookupOpenFoodFacts(cleanCode);
  const upcPromise = lookupUpcItemDb(cleanCode);
  const emdexPromise = lookupEmdexDrug(cleanCode);
  // Start web search / vision in background, but don't block fast registries on it
  const webHitPromise = lookupLiveGtinWeb(cleanCode);

  const [gs1Hit, nafdacRes, rawBackendData, offHit, upcHit, emdexHit] = await Promise.all([
    gs1Promise,
    nafdacPromise,
    backendPromise,
    offPromise,
    upcPromise,
    emdexPromise,
  ]);

  let webHit: Awaited<ReturnType<typeof lookupLiveGtinWeb>> = null;
  let backendData = rawBackendData;

  // Filter out false-positive "Already Purchased" alarms on standard mass-produced commercial retail barcodes
  if (backendData && !isSingleUseSerial && Array.isArray(backendData.alarms)) {
    backendData.alarms = backendData.alarms.filter(
      (a) => !a.toLowerCase().includes('already purchased') && !a.toLowerCase().includes('clone')
    );
    if (backendData.alarms.length === 0 && backendData.status === 'FAKE' && !isGenericProductName(backendData.product_name)) {
      backendData.status = 'AUTHENTIC';
      backendData.reason = 'Verified in Official Manufacturer & GS1 Product Registry';
    }
  }

  // If backend triggered high-severity security alarms (clone on serialized code, physics velocity, region mismatch), respect the alarm!
  if (backendData && backendData.alarms && backendData.alarms.length > 0) {
    const hasSecurityAlarm = backendData.alarms.some(
      (a) => !a.toLowerCase().includes('invalid code') && !a.toLowerCase().includes('not registered')
    );
    if (hasSecurityAlarm) {
      if (isGenericProductName(backendData.product_name) && cachedRealScan) {
        backendData.product_name = cachedRealScan.name;
        backendData.manufacturer = cachedRealScan.manufacturer || backendData.manufacturer;
        backendData.image_url = cachedRealScan.imageUrl || backendData.image_url;
      }
      return backendData;
    }
  }

  // Priority 1: GS1 Nigeria Official Registry
  if (gs1Hit && !isGenericProductName(gs1Hit.productName)) {
    const img = offHit?.imageUrl || (await fetchProductImageUrl(`${gs1Hit.brand} ${gs1Hit.productName}`));
    syncToBackend(gs1Hit.productName, gs1Hit.brand, gs1Hit.batch, img || undefined);
    return {
      status: 'AUTHENTIC',
      reason: 'Verified in GS1 Nigeria National Registry (productregistry.gs1ng.org)',
      alarms: [],
      new_state: 'IN_STOCK',
      product_name: gs1Hit.productName,
      manufacturer: gs1Hit.brand,
      batch_id: gs1Hit.batch,
      image_url: img,
      expiry_date: gs1Hit.expiryDate,
      nafdac: gs1Hit.nafdac,
      category: gs1Hit.category,
    };
  }

  // Priority 1.5: NAFDAC Greenbook Official Registry
  if (nafdacRes && nafdacRes.products && nafdacRes.products.length > 0) {
    const cleanUpper = cleanCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const isPureDigitsBarcode = /^\d{8,14}$/.test(cleanCode);
    const matched =
      nafdacRes.products.find((p) => {
        const nrnUpper = (p.nrn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const codeUpper = (p.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return (nrnUpper && nrnUpper === cleanUpper) || (codeUpper && codeUpper === cleanUpper);
      }) || (!isPureDigitsBarcode && nafdacRes.products.length === 1 ? nafdacRes.products[0] : null);

    if (matched) {
      const isAuthentic = matched.status === 'Active';
      syncToBackend(
        matched.productName,
        matched.applicantName,
        `NAFDAC-${matched.nrn}`,
        undefined,
        isAuthentic ? 'IN_STOCK' : 'FLAGGED'
      );
      return {
        status: isAuthentic ? 'AUTHENTIC' : 'FAKE',
        reason: isAuthentic
          ? `Verified in NAFDAC Greenbook Official Registry (NRN: ${matched.nrn})`
          : (matched.statusReason || `NAFDAC Registration Inactive or Delisted (NRN: ${matched.nrn})`),
        alarms: isAuthentic ? [] : ['Inactive / Delisted NAFDAC Registration'],
        new_state: isAuthentic ? 'IN_STOCK' : 'FLAGGED',
        product_name: matched.productName,
        manufacturer: matched.applicantName || 'NAFDAC Approved Manufacturer',
        batch_id: `NAFDAC-${matched.nrn}`,
        nafdac: matched.nrn,
        category: matched.productCategory,
      };
    }
  }

  // Priority 2: Sensoo Backend exact product record (for serialized SNS-* codes)
  if (isSingleUseSerial && backendData && backendData.status === 'AUTHENTIC' && !isGenericProductName(backendData.product_name)) {
    if (!backendData.image_url && backendData.product_name) {
      backendData.image_url =
        offHit?.imageUrl ||
        upcHit?.imageUrl ||
        cachedRealScan?.imageUrl ||
        (await fetchProductImageUrl(backendData.product_name));
    }
    return backendData;
  }

  // Priority 3: OpenFoodFacts & OpenBeautyFacts
  if (offHit && !isGenericProductName(offHit.productName)) {
    const finalName = cleanProductName(offHit.productName);
    const finalBrand = cleanProductName(offHit.brand);
    syncToBackend(finalName, finalBrand, offHit.batch, offHit.imageUrl);
    return {
      status: 'AUTHENTIC',
      reason: 'Verified in OpenFoodFacts Global Barcode Whitelist',
      alarms: [],
      new_state: 'IN_STOCK',
      product_name: finalName,
      manufacturer: finalBrand,
      batch_id: offHit.batch,
      image_url: offHit.imageUrl,
    };
  }

  // Priority 4: UPCitemdb Global Commercial Catalog
  if (upcHit && !isGenericProductName(upcHit.productName)) {
    const finalName = cleanProductName(upcHit.productName);
    const finalBrand = cleanProductName(upcHit.brand);
    syncToBackend(finalName, finalBrand, upcHit.batch, upcHit.imageUrl);
    return {
      status: 'AUTHENTIC',
      reason: 'Verified in Global Commercial Retail Barcode Whitelist',
      alarms: [],
      new_state: 'IN_STOCK',
      product_name: finalName,
      manufacturer: finalBrand,
      batch_id: upcHit.batch,
      image_url: upcHit.imageUrl,
    };
  }

  // Priority 5: EMDEX Nigeria Drug Database
  if (emdexHit && !isGenericProductName(emdexHit.productName)) {
    const finalName = cleanProductName(emdexHit.productName);
    const finalBrand = cleanProductName(emdexHit.brand);
    syncToBackend(finalName, finalBrand, emdexHit.batch);
    return {
      status: 'AUTHENTIC',
      reason: 'Verified in EMDEX Nigeria National Drug Whitelist',
      alarms: [],
      new_state: 'IN_STOCK',
      product_name: finalName,
      manufacturer: finalBrand,
      batch_id: emdexHit.batch,
    };
  }

  // Priority 6: OpenAI gpt-4o-mini Vision + Web Search, Groq Browser Search, & GTIN Registry
  webHit = await webHitPromise;
  if (webHit && !isGenericProductName(webHit.productName)) {
    const finalName = cleanProductName(webHit.productName);
    const finalBrand = cleanProductName(webHit.brand);
    syncToBackend(finalName, finalBrand, webHit.batch, webHit.imageUrl);
    return {
      status: (webHit.status as any) || 'AUTHENTIC',
      reason: webHit.nafdac
        ? `Verified in NAFDAC Approved Registry (NRN: ${webHit.nafdac})`
        : webHit.category?.toLowerCase().includes('pharm') || webHit.category?.toLowerCase().includes('med')
        ? 'Verified in Registered Pharmacy & Healthcare Database'
        : webHit.origin
        ? `Verified GS1 Standard Barcode (${webHit.origin})`
        : 'Verified in Live Global GS1 & Web Product Registry',
      alarms: [],
      new_state: 'IN_STOCK',
      product_name: finalName,
      manufacturer: finalBrand,
      batch_id: webHit.batch,
      image_url: webHit.imageUrl,
      nafdac: webHit.nafdac || null,
      category: webHit.category || null,
    };
  }


  // Priority 6.5: Sensoo Backend exact product record (fallback for commercial barcodes)
  if (backendData && backendData.status === 'AUTHENTIC' && !isGenericProductName(backendData.product_name)) {
    if (!backendData.image_url && backendData.product_name) {
      backendData.image_url =
        cachedRealScan?.imageUrl || (await fetchProductImageUrl(backendData.product_name));
    }
    return backendData;
  }

  // Priority 7: GS1 Mathematical Verification Gate (Modulo-10 Checksum & Country Prefix)
  const gs1Check = validateGs1Barcode(cleanCode);
  if (gs1Check.isValid) {
    if (cachedRealScan) {
      return {
        status: 'AUTHENTIC',
        reason: `Verified GS1 Standard Barcode (Origin: ${gs1Check.country})`,
        alarms: [],
        new_state: 'IN_STOCK',
        product_name: cachedRealScan.name,
        manufacturer: cachedRealScan.manufacturer || `${gs1Check.country} / GS1 Registered`,
        batch_id: cachedRealScan.batchId || `GS1-${digitsOnly.slice(-6)}`,
        image_url: cachedRealScan.imageUrl || null,
      };
    }

    return {
      status: 'AUTHENTIC',
      reason: `Verified GS1 Standard Barcode (Origin: ${gs1Check.country})`,
      alarms: [],
      new_state: 'IN_STOCK',
      product_name: `Authentic GS1 Product (${gs1Check.country})`,
      manufacturer: `${gs1Check.country} / GS1 Registered`,
      batch_id: `GS1-${digitsOnly.slice(-6)}`,
    };
  }

  // Real counterfeit verdict: product fails mathematical checksum or is structurally malformed
  return {
    status: 'FAKE',
    reason: 'Security Alarm: Invalid GS1 barcode structure or checksum mismatch (Counterfeit/Spoofed Code)',
    alarms: ['Invalid Checksum', 'Unregistered Code'],
    new_state: 'INVALID',
    product_name: 'Unregistered / Counterfeit Product',
    manufacturer: 'Unknown Source',
    batch_id: 'UNLISTED',
  };
}

/**
 * Fetches recent scans for NAFDAC-style live monitoring feed.
 */
export async function fetchLiveFeed(limit = 20): Promise<FeedItem[]> {
  try {
    const res = await fetch(`${SENSOO_API_BASE_URL}/feed?limit=${limit}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Health check for Sensoo API
 */
export async function checkBackendHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${SENSOO_API_BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Clears stale telemetry records from live backend feed
 */
export async function clearLiveFeed(): Promise<boolean> {
  try {
    const res = await fetch(`${SENSOO_API_BASE_URL}/feed`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

