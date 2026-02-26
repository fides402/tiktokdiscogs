import { CONFIG } from '../config.js';

const totalPagesCache = {};
const pendingPageProbes = {};
const criteriaReleasePools = {};
let lastDiscogsCall = 0;

// Persist seen releases across page reloads so the same albums never resurface.
function _loadSeenReleases() {
    try {
        const stored = localStorage.getItem('seen_releases');
        if (stored) return new Set(JSON.parse(stored));
    } catch (e) {}
    return new Set();
}
function _saveSeenReleases() {
    try { localStorage.setItem('seen_releases', JSON.stringify([...seenReleases])); } catch (e) {}
}
const seenReleases = _loadSeenReleases();

async function rateLimitedFetch(url, options) {
    const now = Date.now();
    const elapsed = now - lastDiscogsCall;
    if (elapsed < 400) {
        // Enforce max ~2.5 requests per second (150/min)
        await new Promise(resolve => setTimeout(resolve, 400 - elapsed));
    }
    lastDiscogsCall = Date.now();

    // Prevent browser from caching repeated random parameters across sessions
    options.cache = 'no-store';

    return fetch(url, options);
}

export const discogsService = {
    async fetchRandomRelease(criteria, fetchDetails = false) {
        if (!criteria) {
            throw new Error("No criteria selected");
        }

        // Build query params
        const params = new URLSearchParams({
            type: "release",
            format: "album", // Match rndmsound3
            per_page: 1,     // Match rndmsound3 - fetch only 1 item per API call for absolute randomness
            page: 1
        });

        if (criteria.genre) params.append("genre", criteria.genre);
        if (criteria.style) params.append("style", criteria.style);
        // Handle decade randomly like rndmsound3, or pick a fully random year if not provided
        if (criteria.year) {
            const decadeBase = parseInt(criteria.year, 10);
            const randomYear = decadeBase + Math.floor(Math.random() * 10);
            params.append("year", randomYear.toString());
        } else {
            // Force a random year to scatter results across the database and bypass the 10k limit
            const randomYear = 1960 + Math.floor(Math.random() * 64); // 1960 to 2023
            params.append("year", randomYear.toString());
        }
        if (criteria.country) params.append("country", criteria.country);

        // Mix up sorting to shuffle identical blocks
        const sorts = ["year", "title", "format"];
        params.append("sort", sorts[Math.floor(Math.random() * sorts.length)]);
        params.append("sort_order", Math.random() > 0.5 ? "asc" : "desc");

        const headers = {
            'Authorization': `Discogs token=${CONFIG.DISCOGS_TOKEN}`,
            'User-Agent': "AntiGravityApp/1.0"
        };

        const criteriaKey = JSON.stringify(criteria) + "_" + params.get("year") + "_" + params.get("sort") + "_" + params.get("sort_order");
        const maxRetries = 5;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                let maxItems = totalPagesCache[criteriaKey];
                let data = null;

                if (!maxItems) {
                    if (!pendingPageProbes[criteriaKey]) {
                        pendingPageProbes[criteriaKey] = (async () => {
                            // Step 1: Probe for total items to ensure we don't request out of bounds
                            const initialSearchUrl = `${CONFIG.DISCOGS_BASE_URL}/database/search?${params.toString()}`;
                            let response = await rateLimitedFetch(initialSearchUrl, { headers });

                            if (!response.ok) {
                                if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
                                throw new Error(`Discogs API Error: ${response.status}`);
                            }

                            const resData = await response.json();

                            if (!resData.results || resData.results.length === 0) {
                                const error = new Error("No results for criteria");
                                error.code = 'ZERO_RESULTS';
                                throw error;
                            }

                            // Discogs caps at 10,000 items
                            totalPagesCache[criteriaKey] = Math.min(resData.pagination.items, 10000);
                            return resData;
                        })();
                    }

                    try {
                        data = await pendingPageProbes[criteriaKey];
                        maxItems = totalPagesCache[criteriaKey];
                    } catch (err) {
                        delete pendingPageProbes[criteriaKey];
                        throw err;
                    }
                }

                // Step 2: Pick a random page within the actual bounds (since per_page=1, page = index)
                const randomPage = Math.floor(Math.random() * maxItems) + 1;

                if (randomPage > 1 || !data) {
                    params.set("page", randomPage);
                    const randomSearchUrl = `${CONFIG.DISCOGS_BASE_URL}/database/search?${params.toString()}`;
                    let response = await rateLimitedFetch(randomSearchUrl, { headers });

                    if (!response.ok) {
                        if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
                        throw new Error(`Discogs API Error on random page: ${response.status}`);
                    }
                    data = await response.json();
                }

                // Safety check
                if (!data.results || data.results.length === 0) {
                    throw new Error("No results found on chosen page");
                }

                const randomReleaseSummary = data.results[0];

                // If we've seen this exact one recently, skip and go to next attempt
                if (seenReleases.has(randomReleaseSummary.id)) {
                    continue;
                }

                // Add to seen Set and persist so reloads don't repeat the same releases
                seenReleases.add(randomReleaseSummary.id);
                if (seenReleases.size > 2000) {
                    seenReleases.delete(seenReleases.values().next().value);
                }
                _saveSeenReleases();


                return this.formatReleaseSummary(randomReleaseSummary, criteria, fetchDetails);

            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }

                // Exponential backoff
                const isRateLimit = (error.message === 'TOO_MANY_REQUESTS' || (error.message && error.message.includes('429')));
                const baseDelay = isRateLimit ? 1500 : 500;
                const backoff = Math.min(baseDelay * Math.pow(1.5, attempt), 5000);

                if (isRateLimit) {
                    console.warn(`Discogs Rate Limit hit, waiting ${backoff}ms...`);
                }

                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
    },

    async formatReleaseSummary(randomReleaseSummary, criteria, fetchDetails) {
        // Return simplified metadata immediately if details aren't requested
        if (!fetchDetails) {
            // Title in search results is usually "Artist - Title"
            let artist = "Unknown Artist";
            let title = randomReleaseSummary.title || "Unknown Title";

            if (randomReleaseSummary.title && randomReleaseSummary.title.includes(' - ')) {
                const parts = randomReleaseSummary.title.split(' - ');
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
            }

            return {
                id: randomReleaseSummary.id,
                artist: artist,
                title: title,
                year: randomReleaseSummary.year || criteria.year || "Unknown Year",
                genres: randomReleaseSummary.style || randomReleaseSummary.genre || [criteria.genre || 'Mixed'],
                cover: randomReleaseSummary.cover_image || randomReleaseSummary.thumb || "",
                youtubeVideoIds: [], // We don't have these without details
                youtubePlaylistId: null
            };
        }

        // Fetch full release details only if explicitly asked
        return await this.fetchReleaseDetails(randomReleaseSummary.id, criteria.genre || 'Mixed');
    },

    async fetchReleaseDetails(releaseId, categoryId) {
        const detailsUrl = `${CONFIG.DISCOGS_BASE_URL}/releases/${releaseId}`;
        const headers = {
            'Authorization': `Discogs token=${CONFIG.DISCOGS_TOKEN}`,
            'User-Agent': "AntiGravityApp/1.0"
        };

        const response = await rateLimitedFetch(detailsUrl, { headers });
        if (!response.ok) {
            throw new Error(`Discogs Release API Error: ${response.status}`);
        }

        const release = await response.json();

        // Parse details
        const artist = release.artists && release.artists.length > 0 ? release.artists[0].name : "Unknown Artist";
        const title = release.title || "Unknown Title";
        const year = release.year || "Unknown Year";
        const coverUrl = (release.images && release.images.length > 0) ? release.images[0].uri : null;
        const discogsUrl = release.uri || `https://www.discogs.com/release/${releaseId}`;

        const trackList = release.tracklist ? release.tracklist.map(t => t.title) : [];

        // Find YouTube playlist / video IDs
        let youtubePlaylistId = null;
        const youtubeVideoIds = [];

        if (release.videos && release.videos.length > 0) {
            for (const video of release.videos) {
                if (!video.uri) continue;
                try {
                    if (video.uri.includes("youtu.be/")) {
                        // Short URL: https://youtu.be/VIDEO_ID
                        const vId = new URL(video.uri).pathname.slice(1).split('?')[0];
                        if (vId) youtubeVideoIds.push(vId);
                    } else if (video.uri.includes("youtube.com")) {
                        const tempUrl = new URL(video.uri);
                        const vId = tempUrl.searchParams.get("v");
                        if (vId) {
                            youtubeVideoIds.push(vId);
                        } else {
                            // Check path-based IDs: /embed/ID or /v/ID
                            const pathMatch = tempUrl.pathname.match(/\/(embed|v)\/([a-zA-Z0-9_-]{11})/);
                            if (pathMatch) {
                                youtubeVideoIds.push(pathMatch[2]);
                            } else {
                                // Playlist URL without individual video (e.g. /playlist?list=...)
                                const listId = tempUrl.searchParams.get("list");
                                if (listId && !youtubePlaylistId) {
                                    youtubePlaylistId = listId;
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Intentionally ignore URL parse errors
                }
            }
        }

        return {
            releaseId,
            title,
            artist: artist.replace(/\(\d+\)$/, '').trim(), // Remove Discogs disambiguation numbers like "Artist (2)"
            year,
            category: categoryId,
            coverUrl,
            discogsUrl,
            youtubePlaylistId,
            youtubeVideoIds,
            trackList
        };
    },

    // Call at the start of each new exploration session to reset per-session caches.
    // seenReleases is intentionally NOT cleared here: keeping it persistent across
    // back-and-forth navigations prevents the same albums from cycling back immediately
    // after the user returns to the category screen. The set auto-rotates at 2000 entries.
    clearSession() {
        Object.keys(criteriaReleasePools).forEach(k => delete criteriaReleasePools[k]);
        Object.keys(totalPagesCache).forEach(k => delete totalPagesCache[k]);
        Object.keys(pendingPageProbes).forEach(k => delete pendingPageProbes[k]);
    }
};
