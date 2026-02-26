import { categorySelector } from './modules/categorySelector.js';
import { discogsService } from './modules/discogsService.js';
import { youtubeService } from './modules/youtubeService.js';
import { feedManager } from './modules/feedManager.js';
import { dataBuffer } from './modules/dataBuffer.js';

let activeCriteria = null;

async function init() {
    // Do NOT await ytApiReady here — show the category screen immediately.
    // videoPlayer.createPlayer() already awaits ytApiReady internally, so
    // players are created correctly once the API loads, without blocking the UI.
    const categoryScreen = document.getElementById('category-screen');
    categorySelector.init(categoryScreen);

    document.addEventListener('categoriesSelected', (e) => {
        activeCriteria = e.detail.criteria;

        document.getElementById('category-screen').classList.add('hidden');
        document.getElementById('feed-screen').classList.remove('hidden');

        // Start background pipeline
        dataBuffer.startPipeline(activeCriteria);

        const container = document.getElementById('feed-container');
        feedManager.init(container, async () => {
            return await dataBuffer.consume();
        });
    });

    // "CANALI CURATI" button — starts channel mode without any category selection
    const channelsBtn = document.getElementById('channels-btn');
    if (channelsBtn) {
        channelsBtn.addEventListener('click', () => {
            document.getElementById('category-screen').classList.add('hidden');
            document.getElementById('feed-screen').classList.remove('hidden');

            // Label the back button as HOME since there are no filters in this mode
            const filtersBtn = document.getElementById('open-filters-btn');
            if (filtersBtn) filtersBtn.querySelector('span').textContent = '⚙️ HOME';

            dataBuffer.startChannelPipeline();

            const container = document.getElementById('feed-container');
            feedManager.init(container, async () => {
                return await dataBuffer.consume();
            });
        });
    }

    const openFiltersBtn = document.getElementById('open-filters-btn');
    if (openFiltersBtn) {
        openFiltersBtn.addEventListener('click', () => {
            // Pause current video
            const currentCard = feedManager.cardBuffer[feedManager.currentIndex];
            if (currentCard && currentCard.playerInstance) {
                if (typeof currentCard.playerInstance.pauseVideo === 'function') {
                    currentCard.playerInstance.pauseVideo();
                }
            }

            // Reset back-button label for next session
            openFiltersBtn.querySelector('span').textContent = '⚙️ FILTRI';

            // Go back to category screen
            document.getElementById('feed-screen').classList.add('hidden');
            document.getElementById('category-screen').classList.remove('hidden');

            // Clean up feed container so it reinstantiates clean on next exploration
            const container = document.getElementById('feed-container');
            container.innerHTML = '';
            feedManager.cardBuffer = [];
            dataBuffer.stopPipeline();
            if (feedManager.observer) feedManager.observer.disconnect();
        });
    }

    document.addEventListener('videoEnded', () => {
        feedManager.navigateTo(feedManager.currentIndex + 1);
    });

    document.addEventListener('channelLoadError', () => {
        showError("Impossibile caricare i canali. Controlla la chiave API YouTube.");

        document.getElementById('feed-screen').classList.add('hidden');
        document.getElementById('category-screen').classList.remove('hidden');

        const container = document.getElementById('feed-container');
        container.innerHTML = '';
        feedManager.cardBuffer = [];
        if (feedManager.observer) feedManager.observer.disconnect();
    });

    document.addEventListener('zeroResults', () => {
        showError("Nessun album trovato per questi filtri.");

        // Go back to category screen
        document.getElementById('feed-screen').classList.add('hidden');
        document.getElementById('category-screen').classList.remove('hidden');

        // Clean up feed container
        const container = document.getElementById('feed-container');
        container.innerHTML = '';
        feedManager.cardBuffer = [];
        dataBuffer.stopPipeline();
        if (feedManager.observer) feedManager.observer.disconnect();
    });
}

function showError(msg) {
    const toast = document.getElementById('error-toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}

// Removed manual fetchNextCardData, handled by dataBuffer now.

document.addEventListener('DOMContentLoaded', init);
