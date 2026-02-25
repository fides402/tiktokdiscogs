import { CONFIG } from '../config.js';

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
                // Step 1: Probe for total pages to ensure we don't request out of bounds
                const initialSearchUrl = `${CONFIG.DISCOGS_BASE_URL}/database/search?${params.toString()}`;

                let response = await fetch(initialSearchUrl, { headers });
                if (!response.ok) {
                    throw new Error(`Discogs API Error: ${response.status}`);
                }

                let data = await response.json();

                if (!data.results || data.results.length === 0) {
                    if (attempt === maxRetries) throw new Error("No results for criteria");
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                }

                // Step 2: Now that we know total pages (max 200 by Discogs search limits)
                // Pick a random page within the actual bounds
                const totalPages = Math.min(data.pagination.pages, 200); // hard cap at 200 to be safe
                const randomPage = Math.floor(Math.random() * totalPages) + 1;

                if (randomPage > 1) {
                    params.set("page", randomPage);
                    const randomSearchUrl = `${CONFIG.DISCOGS_BASE_URL}/database/search?${params.toString()}`;
                    // Add a small delay between requests
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    response = await fetch(randomSearchUrl, { headers });

                    if (!response.ok) {
                        if (response.status === 404) {
                            // Fallback to page 1 data if our random page is stubbornly missing
                            console.warn(`Page ${randomPage} not found, falling back to page 1`);
                            // data is already from page 1
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

                // Pick a random release from the results page
                const randomReleaseSummary = data.results[Math.floor(Math.random() * data.results.length)];

                // Small delay before detail fetch
                await new Promise(resolve => setTimeout(resolve, 500));

                // Fetch full release details
                return await this.fetchReleaseDetails(randomReleaseSummary.id, criteria.genre || 'Mixed');

            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }
                // Small delay before retry
                await new Promise(resolve => setTimeout(resolve, 1500));
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
