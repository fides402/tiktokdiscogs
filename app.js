import { categorySelector } from './modules/categorySelector.js';
import { discogsService } from './modules/discogsService.js';
import { youtubeService } from './modules/youtubeService.js';
import { feedManager } from './modules/feedManager.js';
import { dataBuffer } from './modules/dataBuffer.js';

let activeCriteria = null;

async function init() {
    await window.ytApiReady;

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

            // Go back to category screen
            document.getElementById('feed-screen').classList.add('hidden');
            document.getElementById('category-screen').classList.remove('hidden');

            // Optionally clean up feed container totally, so it reinstantiates clean
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
