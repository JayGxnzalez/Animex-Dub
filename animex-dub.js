// AnimexOne DUB Module
// Parallel batched fetching with quality-first priority ordering

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
            return await fetchv2(
                url,
                options.headers || {},
                options.method || 'GET',
                options.body || null,
                true,
                options.encoding || 'utf-8'
            );
        } else {
            return await fetch(url, options);
        }
    } catch(e) {
        try {
            return await fetch(url, options);
        } catch(error) {
            return null;
        }
    }
}

function sleep(ms) {
    if (typeof setTimeout !== 'undefined') {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }
    return new Promise(function(resolve) {
        const start = Date.now();
        function check() {
            if (Date.now() - start >= ms) {
                resolve();
            } else {
                Promise.resolve().then(check);
            }
        }
        check();
    });
}

// ==========================================
// RATE LIMITER
// ==========================================

let lastRequest = 0;
const MIN_INTERVAL = 6000;

async function animexFetch(url) {
    const now = Date.now();
    const timeSinceLast = now - lastRequest;
    if (timeSinceLast < MIN_INTERVAL) {
        await sleep(MIN_INTERVAL - timeSinceLast);
    }
    lastRequest = Date.now();
    return soraFetch(url);
}

// ==========================================
// ANILIST
// ==========================================

const ANILIST_LOOKUP_QUERY = 'query($id: Int) { Page(page: 1, perPage: 1) { media(id: $id) { id idMal averageScore title { romaji english native } episodes nextAiringEpisode { airingAt timeUntilAiring episode } status genres format description startDate { year month day } endDate { year month day } popularity coverImage { color large extraLarge } } } }';

async function anilistFetch(query, variables) {
    try {
        const res = await soraFetch(ANILIST_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ query: query, variables: variables })
        });
        if (!res) return null;
        const json = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        return json && json.data ? json.data : null;
    } catch(e) {
        console.error('Anilist fetch error:' + e);
        return null;
    }
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
    } catch(e) {
        console.error('searchAnimex error:' + e);
        return [];
    }
}

// ==========================================
// PROVIDER PRIORITY
// Batch 1: Hard sub + Best Quality (miku)
// Batch 2: Hard sub + Fastest + High Quality (mochi, mimi)
// Batch 3: Hard sub + Fast (uwu, beep etc)
// Batch 4: Soft sub (yuki) — only if nothing else works
// Skip: kaamx always
// ==========================================

function categorizeProviders(providers) {
    const skip = ['kaamx'];
    const batch1 = [];
    const batch2 = [];
    const batch3 = [];
    const batch4 = [];

    for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (skip.indexOf(p.id) !== -1) continue;

        var tip = (p.tip || '').toLowerCase();
        var isHard = tip.indexOf('hard') !== -1;
        var isBest = tip.indexOf('best quality') !== -1;
        var isFastest = tip.indexOf('fastest') !== -1;
        var isHigh = tip.indexOf('high quality') !== -1;
        var isSoft = tip.indexOf('soft') !== -1;

        if (isHard && isBest) {
            batch1.push(p);
        } else if (isHard && isFastest && isHigh) {
            batch2.push(p);
        } else if (isHard) {
            batch3.push(p);
        } else if (isSoft) {
            batch4.push(p);
        }
    }

    return { batch1: batch1, batch2: batch2, batch3: batch3, batch4: batch4 };
}

// ==========================================
// SUBTITLE EXTRACTOR
// Handles providers that return tracks array
// ==========================================

function extractSubtitles(data) {
    const tracks = data.tracks;
    if (!tracks || !tracks.length) return { subtitles: '', subtitlesHeaders: {}, allSubtitles: [] };

    const headers = data.headers || {};

    const allSubtitles = tracks
        .filter(function(t) { return t.url; })
        .map(function(t) {
            return {
                url: t.url,
                label: t.label || t.lang || 'Unknown',
                kind: t.kind || 'captions',
                headers: headers
            };
        });

    // Prefer default English track, fall back to first caption
    const primary = tracks.find(function(t) { return t.default && t.url; })
        || tracks.find(function(t) { return t.lang === 'en' && t.url; })
        || tracks.find(function(t) { return t.url; });

    return {
        subtitles: primary ? primary.url : '',
        subtitlesHeaders: primary ? headers : {},
        allSubtitles: allSubtitles
    };
}

// ==========================================
// PROVIDER STREAM FETCHER
// Handles multiple sources (uwu) and subtitles (mimi)
// ==========================================

async function fetchProviderStream(slug, epNumber, provider) {
    try {
        const url = ANIMEX_REST + '/sources?id=' + encodeURIComponent(slug) + '&epNum=' + epNumber + '&type=dub&providerId=' + provider.id;
        const res = await soraFetch(url);
        if (!res) return null;
        const data = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        if (!data || !data.sources || !data.sources.length) return null;

        const tip = provider.tip ? ' (' + provider.tip + ')' : '';
        const headers = data.headers || {};
        const subData = extractSubtitles(data);

        // If multiple sources (e.g. uwu returns 1080p, 720p, 360p), return all as separate streams
        if (data.sources.length > 1) {
            return data.sources.map(function(source) {
                const quality = source.quality && source.quality !== 'default' && source.quality !== 'auto'
                    ? ' ' + source.quality
                    : '';
                return {
                    title: provider.id.toUpperCase() + quality + tip,
                    streamUrl: source.url,
                    headers: headers,
                    subtitles: subData.subtitles,
                    subtitlesHeaders: subData.subtitlesHeaders,
                    allSubtitles: subData.allSubtitles
                };
            });
        }

        // Single source
        const source = data.sources[0];
        return [{
            title: provider.id.toUpperCase() + tip,
            streamUrl: source.url,
            headers: headers,
            subtitles: subData.subtitles,
            subtitlesHeaders: subData.subtitlesHeaders,
            allSubtitles: subData.allSubtitles
        }];
    } catch(e) {
        console.error('fetchProviderStream error for ' + provider.id + ':' + e);
        return null;
    }
}

async function fetchBatch(providers, slug, epNumber) {
    await sleep(MIN_INTERVAL);
    const results = await Promise.all(providers.map(function(p) {
        return fetchProviderStream(slug, epNumber, p);
    }));
    // Flatten — each provider can now return array of streams
    const flat = [];
    results.forEach(function(r) {
        if (r) {
            if (Array.isArray(r)) {
                r.forEach(function(s) { flat.push(s); });
            } else {
                flat.push(r);
            }
        }
    });
    return flat;
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
                imageUrl = typeof item.coverImage === 'object'
                    ? (item.coverImage.large || item.coverImage.extraLarge || '')
                    : item.coverImage;
            }
            return {
                title: item.titleEnglish || item.titleRomaji || 'Untitled',
                image: imageUrl,
                href: 'anime/' + item.anilistId + '/' + item.id
            };
        });
        return JSON.stringify(results);
    } catch(e) {
        console.error('searchResults error:' + e);
        return JSON.stringify([]);
    }
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
        const description = anime.description
            ? anime.description.replace(/<[^>]+>/g, '').trim()
            : 'No description available';
        const year = anime.startDate && anime.startDate.year ? String(anime.startDate.year) : 'N/A';
        const score = anime.averageScore ? anime.averageScore + '/100' : 'N/A';

        return JSON.stringify([{
            description: description,
            aliases: 'Score: ' + score,
            airdate: 'Year: ' + year
        }]);
    } catch(e) {
        console.error('extractDetails error:' + e);
        return JSON.stringify([{ description: 'No description available', aliases: 'N/A', airdate: 'N/A' }]);
    }
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
            results.push({
                href: 'anime/' + anilistId + '/' + (match[2] || '') + '/' + i,
                number: i
            });
        }

        return JSON.stringify(results);
    } catch(e) {
        console.error('extractEpisodes error:' + e);
        return JSON.stringify([]);
    }
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
        const dubProviders = serversData.dubProviders || [];

        if (!dubProviders.length) return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });

        const cats = categorizeProviders(dubProviders);
        const streams = [];
        let subtitles = '';
        let subtitlesHeaders = {};
        let allSubtitles = [];

        const processBatchResults = function(results) {
            results.forEach(function(r) {
                streams.push({ title: r.title, streamUrl: r.streamUrl, headers: r.headers });
                if (!subtitles && r.subtitles) {
                    subtitles = r.subtitles;
                    subtitlesHeaders = r.subtitlesHeaders;
                }
                if (r.allSubtitles && r.allSubtitles.length) {
                    r.allSubtitles.forEach(function(s) { allSubtitles.push(s); });
                }
            });
        };

        if (cats.batch1.length) {
            processBatchResults(await fetchBatch(cats.batch1, slug, epNumber));
        }

        if (cats.batch2.length) {
            processBatchResults(await fetchBatch(cats.batch2, slug, epNumber));
        }

        if (cats.batch3.length) {
            processBatchResults(await fetchBatch(cats.batch3, slug, epNumber));
        }

        if (!streams.length && cats.batch4.length) {
            processBatchResults(await fetchBatch(cats.batch4, slug, epNumber));
        }

        return JSON.stringify({ streams: streams, subtitles: subtitles, subtitlesHeaders: subtitlesHeaders, allSubtitles: allSubtitles });
    } catch(e) {
        console.error('extractStreamUrl error:' + e);
        return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
    }
}
