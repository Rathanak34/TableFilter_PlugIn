class TableFilter {
    /**
     * options:
     *  - tableID: string (tbody rows used to build select values)
     *  - columnNames: array of column name strings (index = column)
     *  - columnTypes: optional array of types ("text"|"number"|"date"|...) matching columns; fallback "text"
     *  - storageKey: optional sessionStorage key (defaults to `tableFilters_${tableID}`)
     */
    constructor({ tableID, columnNames, columnTypes = [], storageKey = null, enableSortBox = false}) {
        this.tableID = tableID;
        this.columnNames = columnNames;
        this.columnTypes = columnTypes;
        this.STORAGE_KEY = storageKey || `tableFilters_${tableID}`;
        // whether to show the sort box in modal (default false)
        this.enableSortBox = !!enableSortBox;

        // state
        this.selectedColumn = -1;  // table index (real TH index)
        this.columnType = "text";
        this.currentFilters = {}; // { colIndex: { type, value/values/from/to, columnName, columnType, timestamp } }
        this.currentSort = null;
        this.applyTimeout = null;
        this.isModalOpen = false;
        this._instanceId = 'tf_' + Math.random().toString(36).slice(2, 9);
        this.modalId = `filterModal_${this._instanceId}`;
        this.modalSelector = `#${this.modalId}`;
        this._handlers = {};
        // Prevent double-init
        const tableEl = document.getElementById(this.tableID);
        if (tableEl && tableEl._TableFilterInstance) {
            console.warn(`TableFilter: "${this.tableID}" already initialized — returning existing instance.`);
            return tableEl._TableFilterInstance;
        }
        if (tableEl) tableEl._TableFilterInstance = this;

        // bind
        this.applyFilterAutomatically = this.applyFilterAutomatically.bind(this);
        this.debounce = this.debounce.bind(this);

        // init (NOTE: don't clear saved filters on init)
        this.appendFilterModal();
        this.addFilterButtonsToHeaders(this.tableID, this.columnNames);
        this.loadFiltersFromStorage();
        this.initDOMHandlers();
        this.postInitApply();
    }

    debounce(fn, wait = 300) {
        return (...args) => {
            if (this.applyTimeout) clearTimeout(this.applyTimeout);
            this.applyTimeout = setTimeout(() => fn(...args), wait);
        };
    }
    /* --------------------- Helpers to map indexes --------------------- */

    _getLogicalIndexByTableIndex(tableColIndex) {
        // Return index inside columnNames for the header at tableColIndex, or -1 if not found
        const thead = document.querySelector(`#${this.tableID} thead`);
        if (!thead) return -1;
        const ths = Array.from(thead.querySelectorAll('th'));
        const th = ths[tableColIndex];
        if (!th) return -1;
        // prefer span text if you wrapped the header
        const span = th.querySelector('span');
        const label = (span ? span.textContent : th.textContent).trim();
        // match exactly against the provided columnNames
        return this.columnNames.indexOf(label);
    }

    _getColumnNameByTableIndex(tableColIndex) {
        const li = this._getLogicalIndexByTableIndex(tableColIndex);
        if (li !== -1 && this.columnNames[li]) return this.columnNames[li];
        // fallback to header text
        const thead = document.querySelector(`#${this.tableID} thead`);
        if (!thead) return `Column ${tableColIndex}`;
        const ths = Array.from(thead.querySelectorAll('th'));
        const th = ths[tableColIndex];
        if (!th) return `Column ${tableColIndex}`;
        const span = th.querySelector('span');
        return (span ? span.textContent : th.textContent).trim() || `Column ${tableColIndex}`;
    }

    _getColumnTypeByTableIndex(tableColIndex) {
        const li = this._getLogicalIndexByTableIndex(tableColIndex);
        if (li !== -1 && this.columnTypes[li]) return this.columnTypes[li];
        // if we can't map, try to read data-type attribute on header button (if it exists)
        try {
            const th = document.querySelectorAll(`#${this.tableID} thead th`)[tableColIndex];
            if (th) {
                const btn = th.querySelector('.openFilter');
                if (btn && btn.getAttribute) {
                    const dt = btn.getAttribute('data-type');
                    if (dt) return dt;
                }
            }
        } catch (e) { /* ignore */ }
        return "text";
    }

    /* --------------------- Storage --------------------- */

    loadFiltersFromStorage() {
        try {
            const saved = sessionStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                this.currentFilters = JSON.parse(saved) || {};
                // ensure columnName/columnType are present (compatibility)
                Object.keys(this.currentFilters).forEach(col => {
                    const cf = this.currentFilters[col];
                    if (!cf.columnName) cf.columnName = this._getColumnNameByTableIndex(parseInt(col, 10));
                    if (!cf.columnType) cf.columnType = this._getColumnTypeByTableIndex(parseInt(col, 10));
                });
            }
        } catch (e) {
            console.error('Error loading filters from storage:', e);
            this.currentFilters = {};
        }
    }

    saveFiltersToStorage() {
        try {
            sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.currentFilters));
        } catch (e) {
            console.error('Error saving filters to storage:', e);
        }
    }

    /* --------------------- UI / modal --------------------- */

    appendFilterModal() {
        if (document.getElementById(this.modalId)) return;
        const modalHTML = `
        <div class="modal fade" id="${this.modalId}" tabindex="-1" role="dialog" data-owner="${this._instanceId}">
          <div class="modal-dialog" role="document">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">Filter: <span id="modalColumnName_${this._instanceId}"></span></h5>
                <button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button>
              </div>
              <div class="modal-body">
                <label class="form-label">Filter Type</label>
                <select id="filterType_${this._instanceId}" class="form-control mb-3">
                  <option value="text">Text Filter</option>
                  <option value="select">Select Filter</option>
                  <option value="multiselect">Multi Select Filter</option>
                  <option value="range">Range Filter (From – To)</option>
                </select>

                <div id="textFilterBox_${this._instanceId}">
                  <label class="form-label">Enter filter text:</label>
                  <input type="text" id="filterText_${this._instanceId}" class="form-control" placeholder="Type to filter...">
                </div>

                <div id="selectFilterBox_${this._instanceId}" class="d-none">
                  <label class="form-label">Choose Value:</label>
                  <select id="filterSelect_${this._instanceId}" class="form-control filterSelect2"></select>
                </div>

                <div id="multiSelectFilterBox_${this._instanceId}" class="d-none">
                  <label class="form-label">Choose Values:</label>
                  <select id="filterMultiSelect_${this._instanceId}" class="form-control" multiple size="6" style="height: 120px !important;"></select>
                </div>

                <div id="rangeFilterBox_${this._instanceId}" class="d-none">
                  <label class="form-label">From:</label>
                  <div class="date-wrapper">
                    <input type="date" id="rangeFrom_${this._instanceId}" class="form-control date-input" placeholder="Range from">
                  </div>
                  <label class="form-label mt-2">To:</label>
                  <div class="date-wrapper">
                    <input type="date" id="rangeTo_${this._instanceId}" class="form-control date-input" placeholder="Range To">
                  </div>
                </div>
                   <!-- Sort box (hidden by default) - BUTTONS for better UX -->
                <div id="sortBox_${this._instanceId}" class="d-none mt-3">
                  <label class="form-label">Sort</label>
                  <div id="sortBtns_${this._instanceId}" class="btn-group" role="group" aria-label="Sort options" style="gap:8px;">
                    <button type="button" class="button button1 sort-btn" data-dir="asc" id="sortAsc_${this._instanceId}"><i class="fas fa-sort-alpha-down" style="font-size: 20px;"></i></button>
                    <button type="button" class="button button1 sort-btn" data-dir="desc" id="sortDesc_${this._instanceId}"><i class="fas fa-sort-alpha-up" style="font-size: 20px;"></i></button>
                  </div>
                </div>

              </div>
              <div class="modal-footer">
                <button type="button" class="button button1" id="clearCurrentFilter_${this._instanceId}">Clear Filter</button>
                <button type="button" class="button button1" data-dismiss="modal">Done</button>
              </div>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        if (this.enableSortBox) {
            const sb = document.getElementById(`sortBox_${this._instanceId}`);
            if (sb) sb.classList.remove('d-none');
        }
    }

    _safeShowModal() {
        const selector = this.modalSelector;
        const $m = $(selector);
        if ($m.length === 0) return;
        try {
            if ($m.hasClass && $m.hasClass('in')) return;
            if ($m.is(':visible')) return;
        } catch (e) { }
        try { $m.modal('show'); }
        catch (e) {
            setTimeout(() => { try { $m.modal('show'); } catch (e2) { } }, 120);
        }
    }

    /* --------------------- Headers / buttons --------------------- */

    addFilterButtonsToHeaders(tableID, columnNames) {
        const table = document.getElementById(tableID);
        if (!table) return;
        const headers = table.querySelectorAll('thead th');
        headers.forEach((th, tableColIndex) => {
            const headerLabel = th.innerText.trim();
            const indexOfColumn = columnNames.indexOf(headerLabel);
            if (indexOfColumn === -1) return; // column not declared by user
            const colType = this.columnTypes[indexOfColumn] || "text";
            if (th.querySelector('.openFilter')) return;
            const btn = document.createElement('button');
            btn.className = 'openFilter';
            btn.setAttribute('data-column', tableColIndex);   // REAL table index
            btn.setAttribute('data-column-name', headerLabel);
            btn.setAttribute('data-type', colType);
            btn.setAttribute('title', 'Filter ' + headerLabel);
            btn.style.display = "flex";
            btn.style.width = "20px"; btn.style.height = "19px";
            btn.style.justifyContent = "center"; btn.style.marginLeft = "6px";
            btn.style.borderRadius = "5px";
            btn.innerHTML = '<i style="font-size:13px" class="fa fa-filter"></i>';
            const wrapper = document.createElement('div');
            wrapper.className = 'd-flex align-items-center justify-content-center';
            const textSpan = document.createElement('span'); textSpan.textContent = headerLabel;
            th.innerHTML = '';
            wrapper.appendChild(textSpan); wrapper.appendChild(btn); th.appendChild(wrapper);
        });
    }

    updateActiveFiltersCount() {
        const activeCount = Object.keys(this.currentFilters).length;
        const el = document.getElementById(`activeFiltersCount_${this._instanceId}`);
        if (el) el.textContent = `${activeCount} filter${activeCount !== 1 ? 's' : ''} active`;
        const visibleRows = document.querySelectorAll(`#${this.tableID} tbody tr:not([style*="display: none"])`).length;
        const totalRows = document.querySelectorAll(`#${this.tableID} tbody tr`).length;
        const rc = document.getElementById(`rowCount_${this._instanceId}`);
        if (rc) rc.textContent = `Showing ${visibleRows} of ${totalRows} rows`;
    }

    updateFilterStatus() {
        const statusEl = document.getElementById(`filterStatus_${this._instanceId}`);
        if (!statusEl) return;
        const cf = this.currentFilters[this.selectedColumn];
        let headerLabel = this._getColumnNameByTableIndex(this.selectedColumn);
        if (cf) {
            const finalLabel = headerLabel || cf.columnName || `Column ${this.selectedColumn}`;
            let statusText = '';
            if (cf.type === "text") statusText = `Filter active (${finalLabel}): Contains "${cf.value}"`;
            else if (cf.type === "select") statusText = `Filter active (${finalLabel}): Equals "${cf.value}"`;
            else if (cf.type === "multiselect") statusText = `Filter active (${finalLabel}): ${cf.values.length} value${cf.values.length !== 1 ? 's' : ''} selected`;
            else if (cf.type === "range") {
                let rangeText = [];
                if (cf.from) rangeText.push(`From: ${cf.from}`);
                if (cf.to) rangeText.push(`To: ${cf.to}`);
                statusText = `Filter active (${finalLabel}): ${rangeText.join(', ')}`;
            } else statusText = `Filter active (${finalLabel})`;
            statusEl.innerHTML = `<span class="filter-applied"><i class="bi bi-check-circle"></i> ${statusText}</span>`;
            statusEl.classList.add('filter-applied');
        } else {
            statusEl.textContent = 'No filter applied';
            statusEl.classList.remove('filter-applied');
        }
    }

    updateFilterButtonStyle() {
        const tableElForButtons = document.getElementById(this.tableID);
        if (!tableElForButtons) return;
        tableElForButtons.querySelectorAll(".openFilter").forEach(btn => {
            const col = parseInt(btn.getAttribute("data-column"));
            if (Number.isNaN(col)) return;
            if (this.currentFilters[col]) {
                btn.classList.remove("btn-light");
                btn.classList.add("btn-filter-active");
                let indicator = btn.parentElement.querySelector('.filter-indicator');
                if (!indicator) {
                    indicator = document.createElement('span');
                    indicator.className = 'filter-indicator';
                    indicator.innerHTML = '●';
                    btn.parentElement.appendChild(indicator);
                }
                const filter = this.currentFilters[col];
                let tooltipText = `Filter active: ${filter.columnName}\n`;
                if (filter.type === "text") tooltipText += `Contains: "${filter.value}"`;
                else if (filter.type === "select") tooltipText += `Equals: "${filter.value}"`;
                else if (filter.type === "multiselect") tooltipText += `In: ${filter.values.join(', ')}`;
                else if (filter.type === "range") {
                    let rangeText = [];
                    if (filter.from) rangeText.push(`From: ${filter.from}`);
                    if (filter.to) rangeText.push(`To: ${filter.to}`);
                    tooltipText += rangeText.join(', ');
                }
                btn.title = tooltipText;
            } else {
                btn.classList.remove("btn-filter-active");
                btn.classList.add("btn-light");
                const indicator = btn.parentElement.querySelector('.filter-indicator');
                if (indicator) indicator.remove();
                btn.title = '';
            }
        });
    }

    /* --------------------- Load / populate filter inputs --------------------- */

    formatDateForInput(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return dateString;
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    loadSelectValues(colIndex) {
        const values = new Set();
        document.querySelectorAll(`#${this.tableID} tbody tr`).forEach(row => {
            if (!row.children[colIndex]) return;
            values.add(row.children[colIndex].innerText.trim());
        });

        const single = document.getElementById(`filterSelect_${this._instanceId}`);
        const multi = document.getElementById(`filterMultiSelect_${this._instanceId}`);
        if (single) single.innerHTML = `<option value=""></option>`;
        if (multi) multi.innerHTML = "";

        const colType = this._getColumnTypeByTableIndex(colIndex);
        const arr = Array.from(values);
        if (colType === "number") arr.sort((a, b) => parseFloat(a || 0) - parseFloat(b || 0));
        else if (colType === "date") arr.sort();
        else arr.sort((a, b) => a.localeCompare(b));

        arr.forEach(v => {
            if (single) single.innerHTML += `<option value="${v}">${v}</option>`;
            if (multi) multi.innerHTML += `<option value="${v}">${v}</option>`;
        });

        if (single && single._sf && typeof single._sf.rebuildOptions === 'function') single._sf.rebuildOptions();
        if (multi && multi._sf && typeof multi._sf.rebuildOptions === 'function') multi._sf.rebuildOptions();
    }

    loadSavedFilter(filter) {
        if (!filter) return;
        this._isRestoringFilter = true;
        if (this.filterTypeEl && filter.type) this.filterTypeEl.value = filter.type;
        if (this.filterTextEl && filter.value != null) this.filterTextEl.value = filter.value;
        if (this.filterSelectEl && filter.value != null) {
            this.filterSelectEl.value = filter.value;
            if (this.filterSelectEl._sf && typeof this.filterSelectEl._sf.renderDisplay === 'function') {
                this.filterSelectEl._sf.renderDisplay();
            }
        }
        if (this.filterMultiSelectEl && Array.isArray(filter.values)) {
            [...this.filterMultiSelectEl.options].forEach(opt => { opt.selected = filter.values.includes(opt.value); });
            if (this.filterMultiSelectEl._sf && typeof this.filterMultiSelectEl._sf.renderDisplay === 'function') {
                this.filterMultiSelectEl._sf.renderDisplay();
            }
        }
        if (filter.from != null && this.rangeFromEl) this.rangeFromEl.value = filter.from;
        if (filter.to != null && this.rangeToEl) this.rangeToEl.value = filter.to;
        if (this.filterStatusEl && filter.status != null) this.filterStatusEl.value = filter.status;
        this._isRestoringFilter = false;
    }

    clearInputsButKeepSaved() {
        if (this.filterTextEl) this.filterTextEl.value = '';
        if (this.filterSelectEl) {
            this.filterSelectEl.value = '';
            if (this.filterSelectEl._sf && typeof this.filterSelectEl._sf.renderDisplay === 'function') this.filterSelectEl._sf.renderDisplay();
        }
        if (this.filterMultiSelectEl) {
            [...this.filterMultiSelectEl.options].forEach(opt => opt.selected = false);
            if (this.filterMultiSelectEl._sf && typeof this.filterMultiSelectEl._sf.renderDisplay === 'function') this.filterMultiSelectEl._sf.renderDisplay();
        }
        if (this.rangeFromEl) this.rangeFromEl.value = '';
        if (this.rangeToEl) this.rangeToEl.value = '';
        if (this.filterStatusEl) this.filterStatusEl.value = '';
    }

    /* --------------------- Select search wrapper (unchanged) --------------------- */
    makeSelectSearchable(selectId) {
        const selectEl = document.getElementById(selectId);
        let keyboardIndex = -1; // index of highlighted list item
        if (!selectEl) return;

        // If already initialized, only rebuild options & clear search (do NOT render display here)
        if (selectEl.dataset.sfInit === "1") {
            const sf = selectEl._sf;
            if (sf) {
                // Clear leftover search text
                const existingSearch = sf.dropdown?.querySelector('input[type="search"]');
                if (existingSearch) existingSearch.value = '';

                // Rebuild options from the current <select> options (this repopulates dropdown items)
                if (typeof sf.rebuildOptions === 'function') sf.rebuildOptions();

                // Ensure dropdown is closed
                if (sf.dropdown) sf.dropdown.style.display = 'none';

                // Do NOT call renderDisplay() here — loadSavedFilter will set the selected option and then
                // dispatch a change that triggers renderDisplay. This prevents showing the "previous column" value.
            }
            return;
        }

        // Mark as initialized
        selectEl.dataset.sfInit = "1";

        // Hide original but keep it for value sync and forms
        selectEl.style.display = "none";
        selectEl.tabIndex = -1;

        // Create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'sf-select2-wrapper';

        // Create display box (looks like select)
        const display = document.createElement('div');
        display.className = 'sf-select2-display';

        // left area for text/tags
        const left = document.createElement('div');
        left.className = 'sf-select2-left';
        display.appendChild(left);

        // caret
        const caret = document.createElement('div');
        caret.innerHTML = '&#9662;';
        caret.className = 'sf-select2-caret';
        display.appendChild(caret);

        // Dropdown panel
        const dropdown = document.createElement('div');
        dropdown.className = 'sf-select2-dropdown';
       
        // Search box inside dropdown (top)
        const searchWrap = document.createElement('div');
        searchWrap.className = 'sf-select2-search-wrap';
       
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Search...';
        searchInput.className = 'form-control sf-select2-search-input';
        searchWrap.appendChild(searchInput);
        dropdown.appendChild(searchWrap);

        // Options container
        const optsContainer = document.createElement('div');
        dropdown.appendChild(optsContainer);
        // Insert wrapper into DOM before select and move select into wrapper
        selectEl.parentNode.insertBefore(wrapper, selectEl);
        wrapper.appendChild(display);
        wrapper.appendChild(dropdown);
        wrapper.appendChild(selectEl);

        // helper: rebuild options list from select
        const rebuildOptions = () => {
            optsContainer.innerHTML = '';
            const filterText = (searchInput.value || '').toLowerCase().trim();
            const options = [];

            Array.from(selectEl.options).forEach((opt, i) => {
                const text = (opt.text || '').toString();
                if (filterText && !text.toLowerCase().includes(filterText)) return;

                const item = document.createElement('div');
                item.className = 'sf-select2-option';
                item.textContent = text;
                item.dataset.value = opt.value;

                // Highlight selected
                if (opt.selected) {
                    item.classList.add("sf-selected");
                    item.style.background = '#e9f2ff';
                }

                // Keyboard highlight support
                item.tabIndex = -1;

                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (selectEl.multiple) {
                        opt.selected = !opt.selected;
                        renderDisplay();
                        rebuildOptions();
                    } else {
                        selectEl.value = opt.value;
                        renderDisplay();
                        hideDropdown();
                    }
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                });

                optsContainer.appendChild(item);
                options.push(item);
            });

            // store reference for keyboard nav
            dropdown._options = options;
            keyboardIndex = -1;
        };

        // helper: render display area from selected option(s)
        const renderDisplay = () => {
            left.innerHTML = '';
            if (selectEl.multiple) {
                const selected = Array.from(selectEl.selectedOptions);
                if (selected.length === 0) {
                    const ph = document.createElement('span');
                    ph.style.color = '#888';
                    ph.textContent = 'Select...';
                    left.appendChild(ph);
                } else {
                    selected.forEach(o => {
                        const tag = document.createElement('span');
                        tag.className = 'sf-tag';
                        tag.textContent = o.text;
                       
                        // add remove X
                        const x = document.createElement('span');
                        x.className = 'sf-tag-remove';
                        x.textContent = '✕';
                      
                        x.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            // find option and deselect
                            const value = o.value;
                            const opt = Array.from(selectEl.options).find(_o => _o.value === value);
                            if (opt) opt.selected = false;
                            renderDisplay();
                            rebuildOptions();
                            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                        });
                        tag.appendChild(x);
                        left.appendChild(tag);
                    });
                }
            } else {
                const sel = selectEl.selectedOptions[0];
                if (!sel) {
                    const ph = document.createElement('span');
                    ph.style.color = '#888';
                    ph.textContent = 'Select...';
                    left.appendChild(ph);
                } else {
                    const t = document.createElement('span');
                    t.textContent = sel.text;
                    left.appendChild(t);
                }
            }
        };

        // show/hide dropdown helpers
        const showDropdown = () => {
            dropdown.style.display = 'block';
            searchInput.value = '';
            rebuildOptions();
            searchInput.focus();
            document.addEventListener('keydown', onKeyDown);
        };
        const hideDropdown = () => {
            dropdown.style.display = 'none';
            searchInput.value = '';
            rebuildOptions();
            document.removeEventListener('keydown', onKeyDown);
        };

        // keyboard navigation (Esc to close)
        const onKeyDown = (ev) => {
            const opts = dropdown._options || [];

            if (ev.key === "Escape") {
                hideDropdown();
                return;
            }

            if (ev.key === "ArrowDown") {
                ev.preventDefault();
                if (opts.length === 0) return;

                keyboardIndex = Math.min(keyboardIndex + 1, opts.length - 1);
                highlightKeyboardOption(opts);
                return;
            }

            if (ev.key === "ArrowUp") {
                ev.preventDefault();
                if (opts.length === 0) return;

                keyboardIndex = Math.max(keyboardIndex - 1, 0);
                highlightKeyboardOption(opts);
                return;
            }

            if (ev.key === "Enter") {
                ev.preventDefault();
                if (opts[keyboardIndex]) {
                    opts[keyboardIndex].click();
                }
            }
        };

        const highlightKeyboardOption = (opts) => {
            opts.forEach((o, i) => {
                if (i === keyboardIndex) {
                    o.style.background = "#d8e9ff";
                    o.scrollIntoView({ block: "nearest" });
                } else {
                    o.style.background = (o.classList.contains("sf-selected") ? "#e9f2ff" : "#fff");
                }
            });
        };

        // clicking display toggles dropdown
        display.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (dropdown.style.display === 'block') hideDropdown();
            else showDropdown();
        });

        // when user types in search input
        searchInput.addEventListener('input', () => {
            rebuildOptions();
        });

        // click outside to close
        const onDocumentClick = (e) => {
            if (!wrapper.contains(e.target)) hideDropdown();
        };
        document.addEventListener('click', onDocumentClick);

        // ensure when original select changes externally we update display
        selectEl.addEventListener('change', () => renderDisplay());

        // initial render
        renderDisplay();
        rebuildOptions();

        // store teardown references so future calls can clean up if needed
        selectEl._sf = {
            wrapper, display, dropdown, rebuildOptions, renderDisplay, destroy: () => {
                document.removeEventListener('click', onDocumentClick);
                document.removeEventListener('keydown', onKeyDown);
                if (selectEl._sf) delete selectEl._sf;
            }
        };
    }

    restoreAllOptions(selectEl) {
        Array.from(selectEl.options).forEach(opt => opt.style.display = "");
    }

    /* --------------------- Apply filters --------------------- */

    applyAllFilters() {
        const rows = document.querySelectorAll(`#${this.tableID} tbody tr`);
        let visibleCount = 0;
        rows.forEach(row => {
            let show = true;
            for (let col in this.currentFilters) {
                const filter = this.currentFilters[col];
                const idx = parseInt(col, 10);
                if (!row.children[idx]) { show = false; break; }
                const raw = row.children[idx].innerText.trim();

                if (filter.type === "text") {
                    if (filter.value && !raw.toLowerCase().includes(filter.value.toLowerCase())) { show = false; break; }
                } else if (filter.type === "select") {
                    if (filter.value && filter.value !== "" && raw !== filter.value) { show = false; break; }
                } else if (filter.type === "multiselect") {
                    if (filter.values && filter.values.length > 0 && !filter.values.includes(raw)) { show = false; break; }
                } else if (filter.type === "range") {
                    const rawNormalized = raw.replace(/,/g, '').trim();
                    const colType = filter.columnType || this._getColumnTypeByTableIndex(idx);
                    if (colType === "date") {
                        const rawDate = this.formatDateForInput(raw);
                        const dateValue = new Date(rawDate);
                        if (filter.from) {
                            const fromDate = new Date(filter.from);
                            if (dateValue < fromDate) { show = false; break; }
                        }
                        if (filter.to) {
                            const toDate = new Date(filter.to);
                            if (dateValue > toDate) { show = false; break; }
                        }
                        continue;
                    }
                    // numeric fallback
                    const numValue = parseFloat(rawNormalized);
                    const fromNum = parseFloat((filter.from || "").replace(/,/g, '').trim());
                    const toNum = parseFloat((filter.to || "").replace(/,/g, '').trim());
                    const cellIsNum = !isNaN(numValue);
                    const hasFromNum = !isNaN(fromNum);
                    const hasToNum = !isNaN(toNum);
                    if (hasFromNum || hasToNum) {
                        if (!cellIsNum) { show = false; break; }
                        if (hasFromNum && numValue < fromNum) { show = false; break; }
                        if (hasToNum && numValue > toNum) { show = false; break; }
                        continue;
                    }
                    if (filter.from && raw < filter.from) { show = false; break; }
                    if (filter.to && raw > filter.to) { show = false; break; }
                }
            }
            if (show) { row.style.display = ""; visibleCount++; } else row.style.display = "none";
        });
        return visibleCount;
    }

    /**
 * Sort table rows by a real table column index.
 * direction: 'asc' | 'desc'
 */
    sortTableByColumn(colIndex, direction = 'asc') {
        const tbody = document.querySelector(`#${this.tableID} tbody`);
        if (!tbody) return;
        const allRows = Array.from(tbody.querySelectorAll('tr'));

        // Partition rows into visible vs hidden so we sort only visible ones
        const visibleRows = allRows.filter(r => {
            // prefer style display check, fallback to computed style
            const s = r.style.display;
            if (s && s.toLowerCase() === 'none') return false;
            const cs = window.getComputedStyle(r);
            return cs.display !== 'none';
        });
        const hiddenRows = allRows.filter(r => !visibleRows.includes(r));

        const colType = this._getColumnTypeByTableIndex(colIndex);

        const parseDateSafe = (s) => {
            const ds = this.formatDateForInput((s || '').trim());
            const d = new Date(ds);
            return isNaN(d.getTime()) ? 0 : d.getTime();
        };

        visibleRows.sort((rA, rB) => {
            const aRaw = (rA.children[colIndex] && rA.children[colIndex].innerText) ? rA.children[colIndex].innerText.trim() : '';
            const bRaw = (rB.children[colIndex] && rB.children[colIndex].innerText) ? rB.children[colIndex].innerText.trim() : '';

            let cmp = 0;
            if (colType === 'number') {
                const aNum = parseFloat((aRaw || '').toString().replace(/,/g, ''));
                const bNum = parseFloat((bRaw || '').toString().replace(/,/g, ''));
                const na = isNaN(aNum) ? -Infinity : aNum;
                const nb = isNaN(bNum) ? -Infinity : bNum;
                cmp = na < nb ? -1 : na > nb ? 1 : 0;
            } else if (colType === 'date') {
                const ta = parseDateSafe(aRaw);
                const tb = parseDateSafe(bRaw);
                cmp = ta < tb ? -1 : ta > tb ? 1 : 0;
            } else {
                cmp = (aRaw || '').localeCompare((bRaw || ''), undefined, { numeric: true, sensitivity: 'base' });
            }

            return direction === 'asc' ? cmp : -cmp;
        });

        // Rebuild tbody in a single append (minimize reflow)
        const frag = document.createDocumentFragment();
        visibleRows.forEach(r => frag.appendChild(r));
        hiddenRows.forEach(r => frag.appendChild(r));
        tbody.appendChild(frag);

        // update UI counts / status
        try { this.updateActiveFiltersCount(); } catch (e) { }
    }

    /* --------------------- Auto-apply behavior --------------------- */

    setupAutoApplyListeners() {
        const ft = document.getElementById(`filterText_${this._instanceId}`);
        const sel = document.getElementById(`filterSelect_${this._instanceId}`);
        const msel = document.getElementById(`filterMultiSelect_${this._instanceId}`);
        const rf = document.getElementById(`rangeFrom_${this._instanceId}`);
        const rt = document.getElementById(`rangeTo_${this._instanceId}`);

        if (!this._handlers.debouncedApply) this._handlers.debouncedApply = this.debounce(() => this.applyFilterAutomatically(), 300).bind(this);
        if (!this._handlers.applyNow) this._handlers.applyNow = this.applyFilterAutomatically.bind(this);

        if (ft && !ft._tfAttached) { ft.addEventListener('input', this._handlers.debouncedApply); ft._tfAttached = true; }
        if (sel && !sel._tfAttached) { sel.addEventListener('change', this._handlers.applyNow); sel._tfAttached = true; }
        if (msel && !msel._tfAttached) { msel.addEventListener('change', this._handlers.applyNow); msel._tfAttached = true; }
        if (rf && !rf._tfAttached) { rf.addEventListener('input', this._handlers.debouncedApply); rf.addEventListener('change', this._handlers.applyNow); rf._tfAttached = true; }
        if (rt && !rt._tfAttached) { rt.addEventListener('input', this._handlers.debouncedApply); rt.addEventListener('change', this._handlers.applyNow); rt._tfAttached = true; }
    }

    applyFilterAutomatically() {
        const modalEl = document.getElementById(this.modalId);
        if (!modalEl || modalEl._ownerInstance !== this) return;
        if (!this.isModalOpen || this.selectedColumn < 0) return;

        const filterTypeEl = document.getElementById(`filterType_${this._instanceId}`);
        const type = filterTypeEl ? filterTypeEl.value : 'text';
        const from = (document.getElementById(`rangeFrom_${this._instanceId}`)?.value || '').trim();
        const to = (document.getElementById(`rangeTo_${this._instanceId}`)?.value || '').trim();
        const textVal = (document.getElementById(`filterText_${this._instanceId}`)?.value || '').trim();
        const selectVal = (document.getElementById(`filterSelect_${this._instanceId}`)?.value || '');
        const multiVal = (document.getElementById(`filterMultiSelect_${this._instanceId}`));
        const multiArr = multiVal ? Array.from(multiVal.selectedOptions).map(o => o.value) : [];

        const col = this.selectedColumn;
        const colType = this._getColumnTypeByTableIndex(col);
        const colName = this._getColumnNameByTableIndex(col);

        const filterSettings = { type, column: col, columnType: colType, columnName: colName, timestamp: new Date().toISOString() };

        if (type === 'text') {
            if (textVal === '') { if (this.currentFilters[col] && this.currentFilters[col].type === 'text') delete this.currentFilters[col]; }
            else { filterSettings.value = textVal; this.currentFilters[col] = filterSettings; }
        } else if (type === 'select') {
            if (selectVal === '') { if (this.currentFilters[col] && this.currentFilters[col].type === 'select') delete this.currentFilters[col]; }
            else { filterSettings.value = selectVal; this.currentFilters[col] = filterSettings; }
        } else if (type === 'multiselect') {
            if (multiArr.length === 0) { if (this.currentFilters[col] && this.currentFilters[col].type === 'multiselect') delete this.currentFilters[col]; }
            else { filterSettings.values = multiArr; this.currentFilters[col] = filterSettings; }
        } else if (type === 'range') {
            if (from === '' && to === '') { if (this.currentFilters[col] && this.currentFilters[col].type === 'range') delete this.currentFilters[col]; }
            else { filterSettings.from = from; filterSettings.to = to; this.currentFilters[col] = filterSettings; }
        }

        this.saveFiltersToStorage();
        this.applyAllFilters();
        // If sort box enabled and a sort is chosen, apply sorting after filters
        try {
            if (this.enableSortBox) {
                const sortVal = (this.sortOrderEl && this.sortOrderEl.value) ? this.sortOrderEl.value : (this.currentSort ? this.currentSort.dir : null);
                if (sortVal === 'asc' || sortVal === 'desc') {
                    // ensure currentSort reflects the selected column & dir
                    this.currentSort = { col: this.selectedColumn, dir: sortVal };
                    this.sortTableByColumn(this.selectedColumn, sortVal);
                }
            }
        } catch (e) { console.log(e); }

        this.updateFilterButtonStyle();
        this.updateFilterStatus();
       
    }

    /* --------------------- Clear buttons --------------------- */

    clearCurrentFilterHandler() {
        if (this.selectedColumn < 0) return;
        delete this.currentFilters[this.selectedColumn];
        this.saveFiltersToStorage();
        this.clearInputsButKeepSaved();
        this.applyAllFilters();
        this.updateFilterButtonStyle();
        this.updateFilterStatus();
    }

    clearAllFiltersHandler() {
        this.currentFilters = {};
        this.saveFiltersToStorage();
        document.querySelectorAll(`#${this.tableID} tbody tr`).forEach(row => row.style.display = "");
        this.updateFilterButtonStyle();
        if (this.isModalOpen) this.updateFilterStatus();
        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-success alert-dismissible fade show mt-3';
        alertDiv.innerHTML = `All filters have been cleared.<button type="button" class="close" data-dismiss="alert"><span>&times;</span></button>`;
        document.querySelector('.clearFilterbox')?.after(alertDiv);
        setTimeout(() => { $(alertDiv).alert('close'); }, 3000);
    }

    /* --------------------- Event hookup --------------------- */

    initDOMHandlers() {
        if (this._handlersInitialized) return;
        this._handlersInitialized = true;
        const tableEl = document.getElementById(this.tableID);
        if (!tableEl) return;

        tableEl.querySelectorAll(".openFilter").forEach(btn => {
            if (btn._tfAttached) return;
            btn._tfAttached = true;

            btn.addEventListener("click", (ev) => {
                const col = parseInt(btn.getAttribute("data-column"), 10);
                const dtype = btn.getAttribute("data-type") || this._getColumnTypeByTableIndex(col);

                this.selectedColumn = col;
                this.columnType = dtype;
                this.selectedButton = btn;
                this.isModalOpen = true;

                const titleEl = document.getElementById(`modalColumnName_${this._instanceId}`);
                let headerLabel = btn.getAttribute("data-column-name") || null;
                if (!headerLabel || headerLabel.trim() === "") headerLabel = this._getColumnNameByTableIndex(col);
                const titleText = headerLabel || this._getColumnNameByTableIndex(col) || `Column ${col}`;
                if (titleEl) titleEl.textContent = titleText;

                this.loadSelectValues(col);
                this.makeSelectSearchable(`filterSelect_${this._instanceId}`);
                this.makeSelectSearchable(`filterMultiSelect_${this._instanceId}`);

                this.filterTextEl = document.getElementById(`filterText_${this._instanceId}`);
                this.filterSelectEl = document.getElementById(`filterSelect_${this._instanceId}`);
                this.filterMultiSelectEl = document.getElementById(`filterMultiSelect_${this._instanceId}`);
                this.rangeFromEl = document.getElementById(`rangeFrom_${this._instanceId}`);
                this.rangeToEl = document.getElementById(`rangeTo_${this._instanceId}`);
                this.filterTypeEl = document.getElementById(`filterType_${this._instanceId}`);
                this.filterStatusEl = document.getElementById(`filterStatus_${this._instanceId}`);
                this.sortBoxEl = document.getElementById(`sortBox_${this._instanceId}`);
                this.sortOrderEl = document.getElementById(`sortOrder_${this._instanceId}`);

                let defaultFilterType = "text";
                if (this.currentFilters[col]) defaultFilterType = this.currentFilters[col].type;
                else if (dtype === "date" || dtype === "number") defaultFilterType = "range";

                const singleRangeBox = document.getElementById(`rangeFilterBox_${this._instanceId}`);
                if (defaultFilterType === "range") {
                    if (dtype === "date") {
                        if (singleRangeBox) singleRangeBox.classList.remove("d-none");
                        if (this.rangeFromEl) this.rangeFromEl.type = "date";
                        if (this.rangeToEl) this.rangeToEl.type = "date";
                    } else if (dtype === "number") {
                        if (singleRangeBox) singleRangeBox.classList.remove("d-none");
                        if (this.rangeFromEl) this.rangeFromEl.type = "number";
                        if (this.rangeToEl) this.rangeToEl.type = "number";
                    } else {
                        if (singleRangeBox) singleRangeBox.classList.remove("d-none");
                        if (this.rangeFromEl) this.rangeFromEl.type = "text";
                        if (this.rangeToEl) this.rangeToEl.type = "text";
                    }
                } else {
                    if (singleRangeBox) singleRangeBox.classList.add("d-none");
                }

                if (this.currentFilters[col]) {
                    const saved = this.currentFilters[col];
                    saved.columnType = saved.columnType || this._getColumnTypeByTableIndex(col) || dtype || "text";
                    saved.columnName = saved.columnName || this._getColumnNameByTableIndex(col);
                    this.loadSavedFilter(saved);
                } else {
                    this.clearInputsButKeepSaved();
                }

                const ft = document.getElementById(`filterType_${this._instanceId}`);
                if (ft) { ft.value = defaultFilterType; ft.dispatchEvent(new Event('change')); }
                if (this.filterTypeEl) { this.filterTypeEl.value = defaultFilterType; this.filterTypeEl.dispatchEvent(new Event('change', { bubbles: true })); }

                // If sort box enabled, clear or restore sort setting for this column
                if (this.enableSortBox && this.sortOrderEl) {
                    // If previously stored currentSort matches this column, restore its direction
                    if (this.currentSort && this.currentSort.col === this.selectedColumn) {
                        this.sortOrderEl.value = this.currentSort.dir || '';
                    } else {
                        this.sortOrderEl.value = '';
                    }
                }

                this.setupAutoApplyListeners();
                this.updateFilterStatus();

                const modalEl = document.getElementById(this.modalId);
                if (modalEl) { modalEl._ownerInstance = this; modalEl.dataset.owner = this._instanceId || ''; }
                this._safeShowModal();
            });
        });

        const $instModal = $(this.modalSelector);
        if ($instModal.length) {
            if (!this._modalHandlersAttached) {
                $instModal.on('shown.bs.modal', () => {
                    this.isModalOpen = true;
                    const visibleInput = document.querySelector(`${this.modalSelector} .form-control:not(.d-none)`);
                    if (visibleInput) visibleInput.focus();
                });
                $instModal.on('hidden.bs.modal', () => {
                    this.isModalOpen = false;
                    this.selectedColumn = -1;
                    const el = document.getElementById(this.modalId);
                    if (el) el._ownerInstance = null;
                    // If something inside the modal retained focus, blur it to avoid aria-hidden issues
                    try { if (document.activeElement && el && el.contains(document.activeElement)) document.activeElement.blur(); } catch (e) { }
                });

                this._modalHandlersAttached = true;
            }
        }

        const ftElem = document.getElementById(`filterType_${this._instanceId}`);
        if (ftElem && !ftElem._tfAttached) {
            ftElem._tfAttached = true;
            ftElem.addEventListener("change", (e) => {
                const v = e.target.value;
                const hide = id => document.getElementById(`${id}_${this._instanceId}`)?.classList.add("d-none");
                const show = id => document.getElementById(`${id}_${this._instanceId}`)?.classList.remove("d-none");
                hide("textFilterBox"); hide("selectFilterBox"); hide("multiSelectFilterBox"); hide("rangeFilterBox");
                if (v === "text") show("textFilterBox");
                else if (v === "select") show("selectFilterBox");
                else if (v === "multiselect") show("multiSelectFilterBox");
                else if (v === "range") show("rangeFilterBox");
                this.setupAutoApplyListeners();
                this.updateFilterStatus();
            });

  
            // delegated button handler (attach once)
            const sortBtnsWrap = document.getElementById(`sortBtns_${this._instanceId}`);
            if (sortBtnsWrap && !sortBtnsWrap.dataset.bound) {
                sortBtnsWrap.addEventListener('click', (ev) => {
                    const btn = ev.target.closest && ev.target.closest('.sort-btn, .sort-clear-btn');
                    if (!btn) return;
                    const dir = btn.getAttribute('data-dir') || '';
                    if (!dir) {
                        // Clear sort
                        this.currentSort = null;
                        // after clearing, re-run filters to ensure order restored (no sort)
                        this.applyAllFilters();
                        // remove active styles
                        sortBtnsWrap.querySelectorAll('.sort-btn, .sort-clear-btn').forEach(b => b.classList.remove('active'));
                        return;
                    }

                    // record sort for this column and direction
                    this.currentSort = { col: this.selectedColumn, dir };

                    // Keep filters + sort: apply filters first (visible rows set), then sort visible rows
                    this.applyAllFilters();
                    this.sortTableByColumn(this.selectedColumn, dir);

                    // update active class for UI
                    sortBtnsWrap.querySelectorAll('.sort-btn').forEach(b => {
                        if (b.getAttribute('data-dir') === dir) b.classList.add('active');
                        else b.classList.remove('active');
                    });
                }, { passive: true });

                sortBtnsWrap.dataset.bound = "1";
            }
        }

        const clearCurInst = document.getElementById(`clearCurrentFilter_${this._instanceId}`);
        if (clearCurInst && !clearCurInst._tfAttached) {
            clearCurInst.addEventListener("click", () => this.clearCurrentFilterHandler());
            clearCurInst._tfAttached = true;
        }
        const clearAll = document.getElementById("clearAllFilters");
        if (clearAll && !clearAll._tfAttached) {
            clearAll.addEventListener("click", () => this.clearAllFiltersHandler());
            clearAll._tfAttached = true;
        }
    }

    postInitApply() {
        Object.keys(this.currentFilters).forEach(col => {
            const f = this.currentFilters[col];
            if (f && f.type === "range" && f.columnType === "date") {
                if (f.from) f.from = this.formatDateForInput(f.from);
                if (f.to) f.to = this.formatDateForInput(f.to);
            }
        });

        if (Object.keys(this.currentFilters).length > 0) {
            this.applyAllFilters();
            this.updateFilterButtonStyle();
        }
    }

    static applyTo(selector, options = {}) {
        const tables = document.querySelectorAll(selector);
        if (!tables.length) {
            console.warn(`TableFilter.applyTo: No tables found for selector "${selector}"`);
            return;
        }
        tables.forEach(table => {
            const tableID = table.id;
            if (!tableID) {
                console.error("TableFilter.applyTo Error: Table must have an ID.");
                return;
            }
            if (table._TableFilterInstance) return;
            const instance = new TableFilter({ tableID, ...options });
            table._TableFilterInstance = instance;
        });
    }
}

