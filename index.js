const express = require('express');
const cors = require('cors');
// srt-parser-2 is now imported dynamically below
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- USER CONFIGURATION ---
const OS_API_KEY = 'QM8wTqv1wrBh2ttby7peXbL1nZGWDk2N';
const OS_USERNAME = 'nil3190';
const OS_PASSWORD = '9881912126';
const USER_AGENT = 'SimpleStremioSubtitles v8.0.0';
const API_URL = 'https://api.opensubtitles.com/api/v1';
// --- IMPORTANT: This must be your Vercel production URL ---
const BASE_URL = 'https://stremio-dual-subs.vercel.app';

let authToken = null;

async function loginToOpenSubtitles() {
    if (authToken) return true;
    console.log('Attempting to log into OpenSubtitles...');
    try {
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Api-Key': OS_API_KEY,
                'User-Agent': USER_AGENT 
            },
            body: JSON.stringify({ username: OS_USERNAME, password: OS_PASSWORD })
        });

        const contentType = response.headers.get('content-type');
        if (!response.ok || !contentType || !contentType.includes('application/json')) {
            const errorText = await response.text();
            console.error(`Login failed. Server sent a non-JSON response (Status: ${response.status}):`);
            console.error('--- API Response ---');
            console.error(errorText);
            console.error('--- End of API Response ---');
            return false;
        }

        const data = await response.json();
        if (data.token) {
            authToken = data.token;
            console.log('Successfully logged into OpenSubtitles.');
            return true;
        }
        console.error('Failed to log into OpenSubtitles (JSON response):', data);
        return false;
    } catch (error) {
        console.error('Error during OpenSubtitles login:', error);
        return false;
    }
}

async function searchSubtitles(imdbId, season, episode, language) {
    let query = `imdb_id=${imdbId}&languages=${language}`;
    if (season && episode) {
        query += `&season_number=${season}&episode_number=${episode}`;
    }
    console.log(`Searching for subtitles with query: ${query}`);
    try {
        const response = await fetch(`${API_URL}/subtitles?${query}`, {
            headers: { 
                'Api-Key': OS_API_KEY, 
                'Authorization': `Bearer ${authToken}`,
                'User-Agent': USER_AGENT
            }
        });
        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error(`Error searching for ${language} subtitles:`, error);
        return [];
    }
}

async function getSubtitleContent(fileId) {
    try {
        console.log(`Requesting download link for file ID: ${fileId}`);
        const downloadResponse = await fetch(`${API_URL}/download`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Api-Key': OS_API_KEY, 
                'Authorization': `Bearer ${authToken}`,
                'User-Agent': USER_AGENT
            },
            body: JSON.stringify({ file_id: fileId })
        });
        const downloadData = await downloadResponse.json();
        if (!downloadData.link) {
            console.error(`No download link found for file ID ${fileId}`);
            return null;
        }
        console.log(`Downloading SRT content for file ID ${fileId}`);
        const srtResponse = await fetch(downloadData.link);
        return await srtResponse.text();
    } catch (error) {
        console.error(`Failed to download subtitle for file ID ${fileId}:`, error);
        return null;
    }
}

async function translateSrt(srtContent) {
    console.log('Translating Hungarian SRT to English using AI...');
    const SrtParser = (await import('srt-parser-2')).default;
    const srtParser = new SrtParser();
    const subs = srtParser.fromSrt(srtContent);
    const sourceTexts = subs.map(sub => sub.text);
    const separator = "\n<|sub|>\n";
    const combinedText = sourceTexts.join(separator);
    
    const prompt = `Translate the following subtitle text from Hungarian to English. Each subtitle entry is separated by "${separator}". Maintain the exact number of separators in the output. Do not translate the separator itself. Provide only the translated text.\n\n${combinedText}`;

    try {
        const apiKey = ""; // Vercel environment variable
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const result = await response.json();
        const translatedText = result.candidates[0].content.parts[0].text;
        const translatedTexts = translatedText.split(separator);

        if (translatedTexts.length !== sourceTexts.length) {
            console.error("Mismatch in translated segments count.");
            return null;
        }

        const translatedSubs = subs.map((sub, index) => ({
            ...sub,
            text: translatedTexts[index]
        }));

        return srtParser.toSrt(translatedSubs);

    } catch (error) {
        console.error("Error during AI translation:", error);
        return null;
    }
}


async function mergeSubtitles(srtA, srtB) {
    console.log('Merging subtitle files into a two-line format...');
    const SrtParser = (await import('srt-parser-2')).default;
    const srtParser = new SrtParser();
    const subsA = srtParser.fromSrt(srtA); // English
    const subsB = srtParser.fromSrt(srtB); // Hungarian
    const merged = [];
    
    subsB.forEach(subB => {
        const combinedText = `${subB.text}\n${subsA.find(subA => subA.id === subB.id)?.text || ''}`;
        merged.push({ ...subB, text: combinedText });
    });

    console.log('Merging complete.');
    return srtParser.toSrt(merged);
}


function convertSrtToVtt(srtText) {
    console.log('Converting merged SRT to VTT format...');
    let vttText = "WEBVTT\n\n" + srtText
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    console.log('VTT conversion complete.');
    return vttText;
}

const manifest = {
    id: 'org.simple.dualsubtitles.fixed',
    version: '8.0.0',
    name: 'Dual Subtitles (EN+HU) AI Synced',
    description: 'Provides perfectly synced dual subtitles by translating the best Hungarian subtitle into English.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
    const { type, id } = args;
    console.log(`\n--- New Subtitle Request (SDK Handler) ---`);
    console.log(`Received request for ${type} with id ${id}`);

    if (!await loginToOpenSubtitles()) {
        return Promise.resolve({ subtitles: [] });
    }

    const parts = id.split(':');
    const imdbId = parts[0].replace('tt', '');
    const season = type === 'series' ? parts[1] : null;
    const episode = type === 'series' ? parts[2] : null;

    const hungarianSearchResults = await searchSubtitles(imdbId, season, episode, 'hu');

    if (hungarianSearchResults.length === 0) {
        console.log('No Hungarian subtitles found to use as a sync source.');
        return Promise.resolve({ subtitles: [] });
    }
    
    // Take the top 3 Hungarian results to process
    const topHungarianSubs = hungarianSearchResults.slice(0, 3);
    console.log(`Found ${topHungarianSubs.length} top Hungarian subtitles to process.`);
    
    const subtitlePromises = topHungarianSubs.map(async (huSub) => {
        const huFileId = huSub.attributes.files[0].file_id;
        const releaseName = huSub.attributes.release || `Release #${huSub.id}`;
        
        console.log(`Processing Hungarian subtitle: ${releaseName} (File ID: ${huFileId})`);
        
        const hungarianSrt = await getSubtitleContent(huFileId);
        if (!hungarianSrt) {
            console.log(`Failed to download Hungarian SRT for file ID ${huFileId}`);
            return null;
        }

        const englishSrt = await translateSrt(hungarianSrt);
        if (!englishSrt) {
            console.log(`Failed to translate SRT for file ID ${huFileId}`);
            return null;
        }

        const mergedSrt = await mergeSubtitles(englishSrt, hungarianSrt);
        const vtt = convertSrtToVtt(mergedSrt);

        return {
            id: `ai-merged-${huFileId}`,
            url: `${BASE_URL}/subtitles/${encodeURIComponent(vtt)}`,
            lang: `dual (EN+HU) - ${releaseName} (AI Synced)`
        };
    });

    const subtitles = (await Promise.all(subtitlePromises)).filter(Boolean);

    console.log(`Successfully processed and are now offering ${subtitles.length} AI-synced subtitle options.`);
    console.log(`--- End of Request ---`);
    return Promise.resolve({ subtitles });
});

const app = express();
app.use(cors());

// This route serves the generated VTT content
app.get('/subtitles/:vttContent.vtt', (req, res) => {
    const vtt = decodeURIComponent(req.params.vttContent);
    res.header('Content-Type', 'text/vtt;charset=UTF-8');
    res.send(vtt);
});

const router = getRouter(builder.getInterface());
app.use(router);

// This is the entry point for Vercel
module.exports = app;
