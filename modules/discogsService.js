import { CONFIG } from '../config.js';

const totalPagesCache = {};
const seenReleases = new Set();

export const discogsService = {
    async fetchRandomRelease(criteria) {
        if (!criteria) {
            throw new Error("No criteria selected");
        }

        // Build query params
        const params = new URLSearchParams({
            type: "release",
            per_page: 50,
            page: 1  // Always start with page 1 to discover pagination limits
        });

        if (criteria.genre) params.append("genre", criteria.genre);
        if (criteria.style) params.append("style", criteria.style);
        if (criteria.year) params.append("year", criteria.year);
        if (criteria.country) params.append("country", criteria.country);

        const headers = {
            'Authorization': `Discogs token=${CONFIG.DISCOGS_TOKEN}`,
            'User-Agent': "AntiGravityApp/1.0"
        };

        const maxRetries = 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const criteriaKey = JSON.stringify(criteria);
                let totalPages = totalPagesCache[criteriaKey];
                let data = null;

                if (!totalPages) {
                    // Step 1: Probe for total pages to ensure we don't request out of bounds
                    const initialSearchUrl = `${CONFIG.DISCOGS_BASE_URL}/database/search?${params.toString()}`;
                    let response = await fetch(initialSearchUrl, { headers });

                    if (!response.ok) {
                        if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
                        throw new Error(`Discogs API Error: ${response.status}`);
                    }

                    data = await response.json();

                    if (!data.results || data.results.length === 0) {
                        const error = new Error("No results for criteria");
                        error.code = 'ZERO_RESULTS';
                        throw error;
                    }

                    totalPages = Math.min(data.pagination.pages, 200);
                    totalPagesCache[criteriaKey] = totalPages;
                }

                // Step 2: Pick a random page within the actual bounds
                const randomPage = Math.floor(Math.random() * totalPages) + 1;

                if (randomPage > 1 || !data) {
                    params.set("page", randomPage);
                    const randomSearchUrl = `${CONFIG.DISCOGS_BASE_URL}/database/search?${params.toString()}`;
                    let response = await fetch(randomSearchUrl, { headers });

                    if (!response.ok) {
                        if (response.status === 404 && data) {
                            // Fallback to cached data if possible
                            console.warn(`Page ${randomPage} not found, falling back to data`);
                        } else if (response.status === 429) {
                            throw new Error('TOO_MANY_REQUESTS');
                        } else {
                            throw new Error(`Discogs API Error on random page: ${response.status}`);
                        }
                    } else {
                        data = await response.json();
                    }
                }

                // Safety check again
                if (!data.results || data.results.length === 0) {
                    throw new Error("No results found on chosen page");
                }

                // Filter out recently seen releases
                let unseenResults = data.results.filter(r => !seenReleases.has(r.id));

                // If by some extreme chance all 50 items on this page were seen, fallback to any
                if (unseenResults.length === 0) {
                    unseenResults = data.results;
                }

                // Pick a random release from the results page
                const randomReleaseSummary = unseenResults[Math.floor(Math.random() * unseenResults.length)];

                // Add to seen Set
                seenReleases.add(randomReleaseSummary.id);
                // Keep set size manageable
                if (seenReleases.size > 500) {
                    const iterator = seenReleases.values();
                    seenReleases.delete(iterator.next().value); // Remove oldest
                }

                // Fetch full release details
                return await this.fetchReleaseDetails(randomReleaseSummary.id, criteria.genre || 'Mixed');

            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }

                // Exponential backoff
                const isRateLimit = (error.message === 'TOO_MANY_REQUESTS' || (error.message && error.message.includes('429')));
                const baseDelay = isRateLimit ? 2500 : 500;
                const backoff = Math.min(baseDelay * Math.pow(1.5, attempt), 10000);

                if (isRateLimit) {
                    console.warn(`Discogs Rate Limit hit, waiting ${backoff}ms...`);
                }

                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
    },

    async fetchReleaseDetails(releaseId, categoryId) {
        const detailsUrl = `${CONFIG.DISCOGS_BASE_URL}/releases/${releaseId}`;
        const headers = {
            'Authorization': `Discogs token=${CONFIG.DISCOGS_TOKEN}`,
            'User-Agent': "AntiGravityApp/1.0"
        };

        const response = await fetch(detailsUrl, { headers });
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
                if (video.uri && video.uri.includes("youtube.com")) {
                    try {
                        const tempUrl = new URL(video.uri);
                        const vId = tempUrl.searchParams.get("v");
                        if (vId) {
                            youtubeVideoIds.push(vId);
                        }
                    } catch (e) {
                        // Intentionally ignore URL parse errors
                    }
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
    }
};
