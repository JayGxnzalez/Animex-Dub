// AnimexOne DUB Module
// Parallel fetching with sliding-window rate limiter

const ANIMEX_API = 'https://graphql.animex.one/graphql';
const ANIMEX_REST = 'https://pp.animex.one/rest/api';
const ANILIST_API = 'https://graphql.anilist.co/';

// ==========================================
// SORA FETCH WRAPPER
// ==========================================

async function soraFetch(url, options) {
    options = options || { headers: {}, method: 'GET', body: null };
    try {
        if (typeof fetchv2 !== 'undefined') {
            return await fetchv2(url, options.headers || {}, options.method || 'GET', options.body || null, true, options.encoding || 'utf-8');
        } else {
            return await fetch(url, options);
        }
    } catch(e) {
        try { return await fetch(url, options); } catch(error) { return null; }
    }
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ==========================================
// SLIDING WINDOW RATE LIMITER
// 10 requests per 60 seconds — allows bursts,
// parallel requests fire immediately if under budget
// ==========================================

const ANIMEX_MAX_REQUESTS = 10;
const ANIMEX_WINDOW_MS = 60000;
var animexRequestTimes = [];
var animexAdmission = Promise.resolve();

async function animexFetch(url, options) {
    var ticket = animexAdmission.then(function() { return animexReserveSlot(); });
    animexAdmission = ticket.catch(function() {});
    await ticket;
    return soraFetch(url, options);
}

async function animexReserveSlot() {
    var now = Date.now();
    animexRequestTimes = animexRequestTimes.filter(function(t) { return now - t < ANIMEX_WINDOW_MS; });
    if (animexRequestTimes.length >= ANIMEX_MAX_REQUESTS) {
        var waitTime = ANIMEX_WINDOW_MS - (now - animexRequestTimes[0]) + 50;
        console.log('[RateLimit] Window full, waiting ' + waitTime + 'ms');
        await sleep(waitTime);
        return animexReserveSlot();
    }
    animexRequestTimes.push(Date.now());
}

// ==========================================
// ANILIST
// ==========================================

const ANILIST_LOOKUP_QUERY = 'query($id: Int) { Page(page: 1, perPage: 1) { media(id: $id) { id idMal averageScore title { romaji english native } episodes nextAiringEpisode { airingAt timeUntilAiring episode } status genres format description startDate { year month day } endDate { year month day } popularity coverImage { color large extraLarge } } } }';

async function anilistFetch(query, variables) {
    try {
        const res = await soraFetch(ANILIST_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: query, variables: variables })
        });
        if (!res) return null;
        const json = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        return json && json.data ? json.data : null;
    } catch(e) { return null; }
}

async function searchAnimex(keyword, limit) {
    limit = Math.min(24, Math.max(1, limit || 24));
    const query = 'query FastSearch($query: String, $limit: Int) { catalogAnime(filter: { query: $query }, limit: $limit) { items { id anilistId malId titleRomaji titleEnglish coverImage format status episodeCount seasonYear season color genres bannerImage } } }';
    try {
        const res = await soraFetch(ANIMEX_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: query, variables: { query: keyword, limit: limit } })
        });
        if (!res) return [];
        const json = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        return (json && json.data && json.data.catalogAnime && json.data.catalogAnime.items) || [];
    } catch(e) { return []; }
}

// ==========================================
// SUBTITLE EXTRACTOR
// Filters out thumbnail tracks
// ==========================================

function extractSubtitles(data) {
    const tracks = data.tracks;
    if (!tracks || !tracks.length) return { subtitles: '', subtitlesHeaders: {}, allSubtitles: [] };
    const headers = data.headers || {};
    const allSubtitles = tracks.filter(function(t) { return t.url && t.kind !== 'thumbnails'; }).map(function(t) {
        return { url: t.url, label: t.label || t.lang || 'Unknown', kind: t.kind || 'captions', headers: headers };
    });
    const primary = tracks.find(function(t) { return t.default && t.url && t.kind !== 'thumbnails'; })
        || tracks.find(function(t) { return t.url && t.kind !== 'thumbnails' && t.lang && (t.lang === 'en' || t.lang.toLowerCase().includes('english')); })
        || tracks.find(function(t) { return t.url && t.kind !== 'thumbnails'; });
    return {
        subtitles: primary ? primary.url : '',
        subtitlesHeaders: primary ? headers : {},
        allSubtitles: allSubtitles
    };
}

// ==========================================
// PROVIDER FALLBACK HEADERS
// Only yuki needs a Referer — mimi/mochi work without headers
// ==========================================

const PROVIDER_FALLBACK_HEADERS = {
    'yuki': { 'Referer': 'https://megaplay.buzz/' }
};

// ==========================================
// PROVIDER STREAM FETCHER
// ==========================================

async function fetchProviderStream(slug, epNumber, provider) {
    try {
        const url = ANIMEX_REST + '/sources?id=' + encodeURIComponent(slug) + '&epNum=' + epNumber + '&type=dub&providerId=' + provider.id;
        const res = await animexFetch(url);
        if (!res) return null;
        const data = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        if (!data || !data.sources || !data.sources.length) return null;
        const tip = provider.tip ? ' (' + provider.tip + ')' : '';
        // yuki needs Referer, mimi/mochi work with no headers
        var headers = {};
        if (provider.id === 'yuki') {
            headers = (data.headers && data.headers.Referer) ? data.headers : PROVIDER_FALLBACK_HEADERS['yuki'];
        }
        const subData = extractSubtitles(data);
        const source = data.sources[0];
        return {
            title: provider.id.toUpperCase() + tip,
            streamUrl: source.url,
            headers: headers,
            subtitles: subData.subtitles,
            subtitlesHeaders: subData.subtitlesHeaders,
            allSubtitles: subData.allSubtitles
        };
    } catch(e) {
        console.error('fetchProviderStream error for ' + provider.id + ':' + e);
        return null;
    }
}

// ==========================================
// MODULE FUNCTIONS
// ==========================================

async function searchResults(keyword) {
    try {
        const items = await searchAnimex(keyword, 24);
        const results = items.map(function(item) {
            var imageUrl = '';
            if (item.coverImage) {
                imageUrl = typeof item.coverImage === 'object' ? (item.coverImage.large || item.coverImage.extraLarge || '') : item.coverImage;
            }
            return { title: item.titleEnglish || item.titleRomaji || 'Untitled', image: imageUrl, href: 'anime/' + item.anilistId + '/' + item.id };
        });
        return JSON.stringify(results);
    } catch(e) { return JSON.stringify([]); }
}

async function extractDetails(url) {
    try {
        const match = url.match(/anime\/(\d+)(?:\/([^\/]+))?/);
        if (!match) return JSON.stringify([{ description: 'No description available', aliases: 'N/A', airdate: 'N/A' }]);
        const anilistId = parseInt(match[1]);
        const data = await anilistFetch(ANILIST_LOOKUP_QUERY, { id: anilistId });
        if (!data || !data.Page || !data.Page.media || !data.Page.media[0]) {
            return JSON.stringify([{ description: 'No description available', aliases: 'N/A', airdate: 'N/A' }]);
        }
        const anime = data.Page.media[0];
        const description = anime.description ? anime.description.replace(/<[^>]+>/g, '').trim() : 'No description available';
        const year = anime.startDate && anime.startDate.year ? String(anime.startDate.year) : 'N/A';
        const score = anime.averageScore ? anime.averageScore + '/100' : 'N/A';
        return JSON.stringify([{ description: description, aliases: 'Score: ' + score, airdate: 'Year: ' + year }]);
    } catch(e) { return JSON.stringify([{ description: 'No description available', aliases: 'N/A', airdate: 'N/A' }]); }
}

async function extractEpisodes(url) {
    try {
        const match = url.match(/anime\/(\d+)(?:\/([^\/]+))?/);
        if (!match) return JSON.stringify([]);
        const anilistId = parseInt(match[1]);
        const data = await anilistFetch(ANILIST_LOOKUP_QUERY, { id: anilistId });
        if (!data || !data.Page || !data.Page.media || !data.Page.media[0]) return JSON.stringify([]);
        const anime = data.Page.media[0];
        const episodesCount = anime.episodes || (anime.nextAiringEpisode ? anime.nextAiringEpisode.episode - 1 : 1);
        const results = [];
        for (var i = 1; i <= episodesCount; i++) {
            results.push({ href: 'anime/' + anilistId + '/' + (match[2] || '') + '/' + i, number: i });
        }
        return JSON.stringify(results);
    } catch(e) { return JSON.stringify([]); }
}

async function extractStreamUrl(url) {
    try {
        const match = url.match(/anime\/(\d+)\/([^\/]+)\/(\d+)/);
        if (!match) return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
        const slug = match[2];
        const epNumber = match[3];

        const serversRes = await animexFetch(ANIMEX_REST + '/servers?id=' + encodeURIComponent(slug) + '&epNum=' + epNumber);
        if (!serversRes) return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
        const serversData = typeof serversRes.json === 'function' ? await serversRes.json() : JSON.parse(await serversRes.text());

        const dubProviders = (serversData.dubProviders || []).filter(function(p) { return p.id !== 'kaamx'; });
        if (!dubProviders.length) return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });

        // Fetch all dub providers in parallel — rate limiter handles throttling
        const settled = await Promise.all(dubProviders.map(function(p) { return fetchProviderStream(slug, epNumber, p); }));
        const streams = [];
        var subtitles = '';
        var subtitlesHeaders = {};
        var allSubtitles = [];

        settled.forEach(function(r) {
            if (!r) return;
            streams.push({ title: r.title, streamUrl: r.streamUrl, headers: r.headers });
            if (!subtitles && r.subtitles) { subtitles = r.subtitles; subtitlesHeaders = r.subtitlesHeaders; }
            if (r.allSubtitles && r.allSubtitles.length) { r.allSubtitles.forEach(function(s) { allSubtitles.push(s); }); }
        });

        return JSON.stringify({ streams: streams, subtitles: subtitles, subtitlesHeaders: subtitlesHeaders, allSubtitles: allSubtitles });
    } catch(e) {
        console.error('extractStreamUrl error:' + e);
        return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
    }
}
