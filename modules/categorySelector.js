import { CONFIG } from '../config.js';

export const categorySelector = {
    exploreBtn: null,

    init(containerElement) {
        if (!containerElement) return;

        this.exploreBtn = containerElement.querySelector('#explore-btn');

        // Populate select options
        this.populateSelect('genre-select', CONFIG.GENRES);
        this.populateSelect('style-select', CONFIG.STYLES);
        this.populateSelect('era-select', CONFIG.ERAS);
        this.populateSelect('country-select', CONFIG.COUNTRIES);

        // Set up button listener
        if (this.exploreBtn) {
            this.exploreBtn.addEventListener('click', () => {
                const genre = document.getElementById('genre-select').value;
                const style = document.getElementById('style-select').value;
                const era = document.getElementById('era-select').value;
                const country = document.getElementById('country-select').value;

                const event = new CustomEvent('categoriesSelected', {
                    detail: { criteria: { genre, style, year: era, country } }
                });
                document.dispatchEvent(event);
            });
        }
    },

    populateSelect(elementId, items) {
        const select = document.getElementById(elementId);
        if (!select) return;

        items.forEach(item => {
            const option = document.createElement('option');
            option.value = item;
            option.textContent = item;
            select.appendChild(option);
        });
    }
};
