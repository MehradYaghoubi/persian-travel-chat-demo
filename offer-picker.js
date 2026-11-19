/* Shared, text-only offer controls for customer and operator conversations. */
window.offerMessageText = function (text, offers) {
    if (!offers?.length) return String(text || '');
    const ids = offers.map(offer => String(offer.id) + ')');
    const lines = String(text || '').split('\n').filter(line => {
        const value = line.trim();
        return !ids.some(id => value.startsWith(id)) &&
            !/^پروازهای موجود|^[✈️🏨🚐🛎️🛡️]*\s*(?:بلیط رفت|بلیط برگشت|هتل|ترانسفر فرودگاهی|سالن CIP|بیمه مسافرتی):\s*$/u.test(value) &&
            !value.startsWith('👇 برای ثبت نهایی');
    });
    const remaining = lines.join('\n').trim();
    return remaining || 'گزینه‌های موجود را بررسی کنید و از هر بخش یک مورد انتخاب کنید.';
};

window.createOfferPicker = function (offers, onConfirm) {
    const box = document.createElement('section');
    box.className = 'offer-picker';
    box.setAttribute('aria-label', 'پیشنهادهای قابل انتخاب سفر');
    const title = document.createElement('h4');
    title.textContent = 'گزینه‌های سفر';
    box.appendChild(title);
    const selected = new Map();
    const buttons = [];
    const groups = new Map();
    const labels = {flight:'پرواز رفت', return_flight:'پرواز برگشت', hotel:'هتل', bundle:'پکیج پرواز و هتل', transfer:'ترانسفر', cip:'تشریفات فرودگاهی', insurance:'بیمه مسافرتی'};
    offers.forEach(offer => {
        const service = offer.service || (/^B\d+$/.test(offer.id) ? 'bundle' : 'flight');
        if (!groups.has(service)) groups.set(service, []);
        groups.get(service).push(offer);
    });
    groups.forEach((items, service) => {
        const heading = document.createElement('div');
        heading.className = 'offer-group-label';
        heading.textContent = labels[service] || service;
        box.appendChild(heading);
        items.forEach(offer => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'offer-option';
            button.dataset.oid = String(offer.id);
            button.dataset.unavailable = String(!Number.isFinite(Number(offer.price)) || Number(offer.price) <= 0);
            button.disabled = button.dataset.unavailable === 'true';
            button.setAttribute('aria-pressed', 'false');
            const copy = document.createElement('span');
            copy.className = 'offer-copy';
            const name = document.createElement('strong');
            name.className = 'offer-title';
            name.textContent = offer.title || offer.description || labels[service] || 'پیشنهاد سفر';
            copy.appendChild(name);
            [[offer.description && offer.description !== name.textContent ? offer.description : '', 'offer-description'],
             [offer.date_text, 'offer-date'], [(offer.extras || []).join('، '), 'offer-extras']].forEach(([text, className]) => {
                if (!text) return;
                const detail = document.createElement('span');
                detail.className = className;
                detail.textContent = String(text);
                copy.appendChild(detail);
            });
            const value = document.createElement('span');
            value.className = 'offer-value';
            const amount = document.createElement('span');
            amount.textContent = button.disabled ? 'قیمت در دسترس نیست' : Number(offer.price).toLocaleString('fa-IR') + ' ' + (offer.currency || 'تومان');
            const selection = document.createElement('span');
            selection.className = 'offer-selection';
            selection.textContent = 'انتخاب ' + offer.id;
            value.append(amount, selection);
            button.append(copy, value);
            button.addEventListener('click', () => {
                if (button.disabled) return;
                if (selected.get(service) === offer.id) selected.delete(service);
                else {
                    if (service === 'bundle') selected.clear();
                    else selected.delete('bundle');
                    selected.set(service, offer.id);
                }
                refresh();
            });
            buttons.push({button, offer, service, selection});
            box.appendChild(button);
        });
    });
    const controls = document.createElement('div');
    controls.className = 'offer-controls';
    const confirm = document.createElement('button');
    confirm.type = 'button'; confirm.className = 'offer-confirm';
    confirm.textContent = 'ادامه با انتخاب‌ها';
    confirm.addEventListener('click', () => {
        if (confirm.disabled || !selected.size) return;
        box.querySelectorAll('button').forEach(button => button.disabled = true);
        box.setAttribute('aria-busy', 'true');
        onConfirm([...selected.values()]);
    });
    const clear = document.createElement('button');
    clear.type = 'button'; clear.textContent = 'پاک کردن انتخاب‌ها';
    clear.addEventListener('click', () => { selected.clear(); refresh(); });
    controls.append(confirm, clear); box.appendChild(controls);
    const summary = document.createElement('div');
    summary.className = 'offer-summary'; summary.setAttribute('aria-live', 'polite');
    box.appendChild(summary);
    function refresh() {
        buttons.forEach(({button, offer, service, selection}) => {
            const active = selected.get(service) === offer.id;
            button.setAttribute('aria-pressed', String(active));
            selection.textContent = active ? '✓ انتخاب شد' : 'انتخاب ' + offer.id;
        });
        confirm.disabled = !selected.size;
        summary.textContent = selected.size ? selected.size.toLocaleString('fa-IR') + ' گزینه انتخاب شده' : 'از هر بخش یک گزینه انتخاب کنید.';
    }
    refresh();
    box.setPending = pending => {
        buttons.forEach(({button}) => button.disabled = pending || button.dataset.unavailable === 'true');
        confirm.disabled = pending || !selected.size;
        clear.disabled = pending;
        box.setAttribute('aria-busy', String(pending));
    };
    return box;
};
