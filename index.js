const express = require('express');
const cors = require('cors');
// srt-parser-2 is now imported dynamically below
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- USER CONFIGURATION ---
const OS_API_KEY = 'QM8wTqv1wrBh2ttby7peXbL1nZGWDk2N';
const OS_USERNAME = 'nil3190';
const OS_PASSWORD = '9881912126';
const USER_AGENT = 'SimpleStremioSubtitles v6.0.0';
const API_URL = 'https://api.opensubtitles.com/api/v1';

let authToken = null;

// Helper function to convert SRT time to milliseconds
const timeToMs = time => time.split(/[:,]/).reduce((acc, val, i) => acc + Number(val) * [3600000, 60000, 1000, 1][i], 0);

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

        // Improved error logging
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

async function searchSubtitles(imdbId, season, episode) {
    let query = `imdb_id=${imdbId}&languages=en,hu`;
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
        console.error('Error searching subtitles:', error);
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

async function mergeSubtitles(srtA, srtB) {
    console.log('Merging subtitle files with tolerant one-to-one matching...');
    const SrtParser = (await import('srt-parser-2')).default;
    const srtParser = new SrtParser();
    const subsA = srtParser.fromSrt(srtA);
    const subsB = srtParser.fromSrt(srtB);
    const merged = [];
    
    subsA.forEach(sub => sub.startTimeMs = timeToMs(sub.startTime));
    subsB.forEach(sub => sub.startTimeMs = timeToMs(sub.startTime));

    const tolerance = 500; // Time window in milliseconds (+/- 500ms)
    const usedSubsB = new Set(); // Keep track of used secondary subtitles

    subsA.forEach(subA => {
        let bestMatch = null;
        let smallestDiff = Infinity;

        for (let i = 0; i < subsB.length; i++) {
            // Skip if this sub has already been used
            if (usedSubsB.has(i)) continue;

            const subB = subsB[i];
            const diff = Math.abs(subA.startTimeMs - subB.startTimeMs);

            if (diff <= tolerance && diff < smallestDiff) {
                smallestDiff = diff;
                bestMatch = { ...subB, index: i };
            }
        }

        // Add a zero-width space (\u200B) before the second line to fix wrapping issues in some players
        const combinedText = `${subA.text}\n\u200B${bestMatch ? bestMatch.text : ''}`;
        merged.push({ ...subA, text: combinedText });

        // Mark the best match as used so it can't be paired again
        if (bestMatch) {
            usedSubsB.add(bestMatch.index);
        }
    });

    merged.sort((a, b) => a.startTimeMs - b.startTimeMs);
    merged.forEach((sub, index) => sub.id = (index + 1).toString());
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
    version: '6.0.0',
    name: 'Dual Subtitles (EN+HU) Fixed',
    description: 'Fetches and merges English and Hungarian subtitles into a two-line format.',
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

    const searchResults = await searchSubtitles(imdbId, season, episode);

    if (searchResults.length === 0) {
        console.log('No subtitles found on OpenSubtitles for this content.');
        return Promise.resolve({ subtitles: [] });
    }

    const englishSubs = searchResults.filter(s => s.attributes.language === 'en').slice(0, 5);
    const hungarianSubs = searchResults.filter(s => s.attributes.language === 'hu').slice(0, 5);

    if (englishSubs.length === 0 || hungarianSubs.length === 0) {
        console.log('Could not find subtitles for both languages in the top results.');
        return Promise.resolve({ subtitles: [] });
    }

    console.log(`Found ${englishSubs.length} English and ${hungarianSubs.length} Hungarian subs to process.`);
    
    const efficientPairs = [];
    const maxPairs = Math.min(englishSubs.length, hungarianSubs.length);
    for (let i = 0; i < maxPairs; i++) {
        efficientPairs.push({
            enFileId: englishSubs[i].attributes.files[0].file_id,
            huFileId: hungarianSubs[i].attributes.files[0].file_id,
            releaseName: englishSubs[i].attributes.release || `Release #${i + 1}`
        });
    }

    console.log(`Created ${efficientPairs.length} efficient subtitle pairs to process.`);
    
    const subtitlePromises = efficientPairs.map(async (pair) => {
        console.log(`Processing pair: EN File ID ${pair.enFileId}, HU File ID ${pair.huFileId}`);
        const [srtA, srtB] = await Promise.all([
            getSubtitleContent(pair.enFileId),
            getSubtitleContent(pair.huFileId)
        ]);

        if (!srtA || !srtB) {
            console.log(`Failed to download one or both subtitles for pair EN:${pair.enFileId}, HU:${pair.huFileId}`);
            return null;
        }

        const mergedSrt = await mergeSubtitles(srtA, srtB);
        const vtt = convertSrtToVtt(mergedSrt);

        return {
            id: `merged-${pair.enFileId}-${pair.huFileId}`,
            url: `data:text/vtt;base64,${Buffer.from(vtt).toString('base64')}`,
            lang: `dual (EN+HU) - ${pair.releaseName}`
        };
    });

    const subtitles = (await Promise.all(subtitlePromises)).filter(Boolean);

    console.log(`Successfully processed and are now offering ${subtitles.length} merged subtitle options.`);
    console.log(`--- End of Request ---`);
    return Promise.resolve({ subtitles });
});

const app = express();
app.use(cors());
const router = getRouter(builder.getInterface());
app.use(router);

// This is the entry point for Vercel
module.exports = app;
