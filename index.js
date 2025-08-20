const express = require('express');
const cors = require('cors');
const SrtParser = require('srt-parser-2');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const OS_API_KEY = 'QM8wTqv1wrBh2ttby7peXbL1nZGWDk2N';
const OS_USERNAME = 'nil3190';
const OS_PASSWORD = '9881912126';
const USER_AGENT = 'SimpleStremioSubtitles v5.3.0';
const API_URL = 'https://api.opensubtitles.com/api/v1';

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
        const data = await response.json();
        if (data.token) {
            authToken = data.token;
            console.log('Successfully logged into OpenSubtitles.');
            return true;
        }
        console.error('Failed to log into OpenSubtitles:', data);
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

function mergeSubtitles(srtA, srtB) {
    console.log('Merging subtitle files into a two-line format...');
    const srtParser = new SrtParser.default();
    const subsA = srtParser.fromSrt(srtA);
    const subsB = srtParser.fromSrt(srtB);
    const merged = [];
    const subsBMap = new Map(subsB.map(sub => [sub.startTime, sub]));

    subsA.forEach(subA => {
        const subB = subsBMap.get(subA.startTime);
        const combinedText = `${subA.text}\n${subB ? subB.text : ''}`;
        merged.push({ ...subA, text: combinedText });
        if (subB) subsBMap.delete(subA.startTime);
    });

    subsBMap.forEach(subB => {
        merged.push({ ...subB, text: `\n${subB.text}` });
    });

    merged.sort((a, b) => {
        const timeToMs = time => time.split(/[:,]/).reduce((acc, val, i) => acc + Number(val) * [3600000, 60000, 1000, 1][i], 0);
        return timeToMs(a.startTime) - timeToMs(b.startTime);
    });

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
    version: '5.3.0',
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

    const englishSubs = searchResults.filter(s => s.attributes.language === 'en');
    const hungarianSubs = searchResults.filter(s => s.attributes.language === 'hu');

    if (englishSubs.length === 0 || hungarianSubs.length === 0) {
        console.log('Could not find subtitles for both languages in the search results.');
        return Promise.resolve({ subtitles: [] });
    }

    console.log(`Found ${englishSubs.length} potential English subs and ${hungarianSubs.length} potential Hungarian subs.`);
    
    const allPairs = englishSubs.flatMap(enSub =>
        hungarianSubs.map(huSub => ({
            enFileId: enSub.attributes.files[0].file_id,
            huFileId: huSub.attributes.files[0].file_id,
            releaseName: enSub.attributes.release || `Release ${enSub.id}`
        }))
    );

    console.log(`Created ${allPairs.length} possible subtitle pairs to process.`);
    
    const subtitles = [];
    const batchSize = 5; // Reduced batch size for serverless environment
    for (let i = 0; i < allPairs.length; i += batchSize) {
        const batch = allPairs.slice(i, i + batchSize);
        console.log(`--- Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(allPairs.length / batchSize)} ---`);
        
        const batchPromises = batch.map(async (pair) => {
            console.log(`Processing pair: EN File ID ${pair.enFileId}, HU File ID ${pair.huFileId}`);
            const [srtA, srtB] = await Promise.all([
                getSubtitleContent(pair.enFileId),
                getSubtitleContent(pair.huFileId)
            ]);

            if (!srtA || !srtB) {
                console.log(`Failed to download one or both subtitles for pair EN:${pair.enFileId}, HU:${pair.huFileId}`);
                return null;
            }

            const mergedSrt = mergeSubtitles(srtA, srtB);
            const vtt = convertSrtToVtt(mergedSrt);

            return {
                id: `merged-${pair.enFileId}-${pair.huFileId}`,
                url: `data:text/vtt;base64,${Buffer.from(vtt).toString('base64')}`,
                lang: `dual (EN+HU) - ${pair.releaseName}`
            };
        });

        const results = await Promise.all(batchPromises);
        subtitles.push(...results.filter(Boolean));

        if (i + batchSize < allPairs.length) {
            console.log(`--- Batch complete. Waiting 1 second before next batch... ---`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

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
