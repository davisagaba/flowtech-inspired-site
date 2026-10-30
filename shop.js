// Shared shop utilities: favorites, compare, toast, search, region selector.
// Depends on catalog.js being loaded first.

const STORAGE_KEYS = {
  favorites: "vb_favorites",
  compare: "vb_compare",
  recentSearches: "vb_recent_searches",
  region: "vb_region",
};

const REGIONS = ["United Kingdom", "Turkey", "Italy", "Germany", "France", "India", "Russia", "Global"];

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function writeList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable, ignore */
  }
}

// ---------- Toast ----------
function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("toast-visible");
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove("toast-visible"), 2500);
}

// ---------- Favorites ----------
function getFavorites() {
  return readList(STORAGE_KEYS.favorites);
}
function isFavorite(id) {
  return getFavorites().includes(Number(id));
}
function toggleFavorite(id) {
  id = Number(id);
  let favs = getFavorites();
  let added;
  if (favs.includes(id)) {
    favs = favs.filter((f) => f !== id);
    added = false;
  } else {
    favs.push(id);
    added = true;
  }
  writeList(STORAGE_KEYS.favorites, favs);
  document.querySelectorAll(`.favorite-btn[data-id="${id}"]`).forEach((btn) => {
    btn.classList.toggle("favorite-active", added);
    btn.setAttribute("aria-pressed", added ? "true" : "false");
  });
  updateFavoritesCount();
  showToast(added ? "Product successfully added to favorites" : "Removed from favorites");
  return added;
}
function updateFavoritesCount() {
  const count = getFavorites().length;
  document.querySelectorAll(".favorites-count").forEach((el) => {
    el.textContent = count;
    el.hidden = count === 0;
  });
}

// ---------- Compare ----------
const COMPARE_LIMIT = 4;
function getCompare() {
  return readList(STORAGE_KEYS.compare);
}
function isCompared(id) {
  return getCompare().includes(Number(id));
}
function toggleCompare(id) {
  id = Number(id);
  let list = getCompare();
  let added;
  if (list.includes(id)) {
    list = list.filter((f) => f !== id);
    added = false;
  } else {
    if (list.length >= COMPARE_LIMIT) {
      showToast(`You can compare up to ${COMPARE_LIMIT} products`);
      return false;
    }
    list.push(id);
    added = true;
  }
  writeList(STORAGE_KEYS.compare, list);
  document.querySelectorAll(`.compare-checkbox[data-id="${id}"]`).forEach((cb) => (cb.checked = added));
  renderCompareBar();
  return added;
}
function renderCompareBar() {
  const list = getCompare();
  let bar = document.querySelector(".compare-bar");
  if (list.length === 0) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "compare-bar";
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span>${list.length} item${list.length > 1 ? "s" : ""} selected to compare</span>
    <div class="compare-bar-actions">
      <a href="compare.html" class="btn-cta small">Compare Now</a>
      <button type="button" class="btn-outline small" id="compare-clear">Clear</button>
    </div>
  `;
  document.getElementById("compare-clear")?.addEventListener("click", () => {
    writeList(STORAGE_KEYS.compare, []);
    document.querySelectorAll(".compare-checkbox").forEach((cb) => (cb.checked = false));
    renderCompareBar();
  });
}

// ---------- Search ----------
function searchCatalog(query) {
  query = query.trim().toLowerCase();
  if (query.length < 3) return [];
  return CATALOG.filter(
    (p) => p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query)
  ).slice(0, 8);
}
function getRecentSearches() {
  return readList(STORAGE_KEYS.recentSearches);
}
function addRecentSearch(term) {
  term = term.trim();
  if (!term) return;
  let list = getRecentSearches().filter((t) => t.toLowerCase() !== term.toLowerCase());
  list.unshift(term);
  writeList(STORAGE_KEYS.recentSearches, list.slice(0, 5));
}
function clearRecentSearches() {
  writeList(STORAGE_KEYS.recentSearches, []);
}

function productDetailUrl(product) {
  const img = getProductImages(product, 500)[0];
  return `product-detail.html?id=${product.id}`;
}

function initSearchUI() {
  const searchBtn = document.querySelector(".nav-search");
  const searchPanel = document.querySelector(".search-panel");
  const searchInput = document.querySelector(".search-input");
  const searchResults = document.querySelector(".search-results");
  if (!searchBtn || !searchPanel || !searchInput || !searchResults) return;

  function renderRecent() {
    const recent = getRecentSearches();
    if (recent.length === 0) {
      searchResults.innerHTML = '<p class="search-hint">Type at least 3 characters to search.</p>';
      return;
    }
    searchResults.innerHTML =
      '<p class="search-recent-label">Your Last Searches <button type="button" id="clear-recent">Clear</button></p>' +
      recent.map((term) => `<button type="button" class="search-recent-item" data-term="${term}">${term}</button>`).join("");
    document.getElementById("clear-recent")?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearRecentSearches();
      renderRecent();
    });
    searchResults.querySelectorAll(".search-recent-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        searchInput.value = btn.dataset.term;
        runSearch(btn.dataset.term);
      });
    });
  }

  function runSearch(term) {
    if (term.trim().length < 3) {
      renderRecent();
      return;
    }
    const results = searchCatalog(term);
    if (results.length === 0) {
      searchResults.innerHTML = '<p class="search-hint">No products found.</p>';
      return;
    }
    searchResults.innerHTML = results
      .map(
        (p) => `<a class="search-result-item" href="${productDetailUrl(p)}">
          <img src="${getProductImages(p, 60)[0]}" alt="${p.name}">
          <span><strong>${p.name}</strong><br><span class="search-result-cat">${p.category} · ${formatPrice(p.price)}</span></span>
        </a>`
      )
      .join("");
  }

  searchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    searchPanel.classList.toggle("search-panel-open");
    if (searchPanel.classList.contains("search-panel-open")) {
      renderRecent();
      searchInput.focus();
    }
  });

  searchInput.addEventListener("input", () => runSearch(searchInput.value));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchInput.value.trim().length >= 3) {
      addRecentSearch(searchInput.value.trim());
      runSearch(searchInput.value);
    }
  });

  document.addEventListener("click", (e) => {
    if (!searchPanel.contains(e.target) && e.target !== searchBtn) {
      searchPanel.classList.remove("search-panel-open");
    }
  });
}

// ---------- Region selector ----------
function initRegionSelector() {
  document.querySelectorAll(".region-select").forEach((el) => {
    const current = localStorage.getItem(STORAGE_KEYS.region) || "United Kingdom";
    const select = document.createElement("select");
    select.className = "region-select-input";
    REGIONS.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = "Region: " + r;
      if (r === current) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      try {
        localStorage.setItem(STORAGE_KEYS.region, select.value);
      } catch { /* ignore */ }
      showToast("Region set to " + select.value + " (demo only — content does not change)");
    });
    el.replaceWith(select);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initSearchUI();
  initRegionSelector();
  updateFavoritesCount();
  renderCompareBar();
});
