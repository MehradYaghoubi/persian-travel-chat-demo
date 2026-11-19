const chat = document.querySelector('#chat');
const input = document.querySelector('#message');
const messages = document.querySelector('#messages');
const reset = document.querySelector('#reset');
const fields = [
  { key: 'origin', prompt: 'از کدام شهر حرکت می‌کنید؟', hint: 'مثال: تهران' },
  { key: 'destination', prompt: 'مقصد کدام شهر است؟', hint: 'مثال: مشهد' },
  { key: 'date', prompt: 'چه تاریخی می‌خواهید سفر کنید؟', hint: 'مثال: فردا یا ۵ آذر' },
  { key: 'count', prompt: 'چند نفر سفر می‌کنید؟', hint: 'مثال: ۲' },
];
const format = new Intl.NumberFormat('fa-IR');
const exampleOffers = [
  { id: 'F1', service: 'flight', title: 'پرواز نمونه صبح', description: 'ساعت ۹:۳۰', unitPrice: 1200000 },
  { id: 'F2', service: 'flight', title: 'پرواز نمونه عصر', description: 'ساعت ۱۷:۰۰', unitPrice: 1500000 },
  { id: 'H1', service: 'hotel', title: 'اقامت نمونه', description: 'یک شب برای گروه', unitPrice: 900000 },
];
let trip = {};
let step = 0;

function addMessage(text, speaker = 'bot', highlight = false) {
  const message = document.createElement('div');
  message.className = `msg ${speaker}${highlight ? ' notice' : ''}`;
  message.textContent = text;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
}

function ask() {
  const field = fields[step];
  addMessage(field.prompt);
  input.placeholder = field.hint;
}

function start() {
  trip = {};
  step = 0;
  messages.replaceChildren();
  chat.hidden = false;
  input.value = '';
  addMessage('سلام! این گفت‌وگو یک نسخه نمایشی است و رزروی ثبت نمی‌کند.');
  ask();
}

chat.addEventListener('submit', (event) => {
  event.preventDefault();
  if (step >= fields.length) return;
  const answer = input.value.trim();
  if (!answer) return;
  const field = fields[step];
  if (field.key === 'count') {
    const digits = answer.replace(/[۰-۹٠-٩]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'.indexOf(digit) % 10));
    if (!/^(?:[1-9]|10)$/.test(digits)) {
      addMessage('تعداد مسافران را با یک عدد از ۱ تا ۱۰ وارد کنید.');
      return;
    }
    trip.count = Number(digits);
  } else {
    trip[field.key] = answer;
  }
  addMessage(answer, 'user');
  input.value = '';
  step++;
  if (step < fields.length) {
    ask();
    input.focus();
    return;
  }
  chat.hidden = true;
  addMessage('گزینه‌های زیر فرضی هستند. از هر بخش یک گزینه انتخاب کنید.');
  const offers = exampleOffers.map(({ unitPrice, ...offer }) => ({
    ...offer,
    price: unitPrice * (offer.service === 'flight' ? trip.count : 1),
  }));
  const picker = window.createOfferPicker(offers, (ids) => {
    const picked = offers.filter((offer) => ids.includes(offer.id));
    const total = picked.reduce((sum, offer) => sum + offer.price, 0);
    picker.remove();
    addMessage([
      'خلاصه سفر فرضی',
      `مسیر: ${trip.origin} به ${trip.destination}`,
      `تاریخ: ${trip.date}`,
      `مسافران: ${format.format(trip.count)} نفر`,
      ...picked.map((offer) => `${offer.title} · ${format.format(offer.price)} تومان`),
      `جمع فرضی: ${format.format(total)} تومان`,
      'این پیش‌نمایش هیچ رزروی ثبت نمی‌کند.',
    ].join('\n'), 'bot', true);
    reset.focus();
  });
  messages.append(picker);
  picker.scrollIntoView({ block: 'end' });
  picker.querySelector('.offer-option')?.focus({ preventScroll: true });
});

reset.addEventListener('click', () => {
  start();
  input.focus();
});
start();

const contact = document.querySelector('#contact');
const support = document.querySelector('#support');
const supportInput = document.querySelector('#support-message');
const channel = document.querySelector('#support-channel');
let sessionId;
let cursor = 0;
let timer;
let generation = 0;
let sending = false;

async function supportRequest(path = '', body) {
  const res = await fetch('/api/customer' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'خطای سرور محلی');
  return data;
}

function showSupportHistory(data) {
  for (const message of data.messages.slice(cursor)) {
    addMessage(message.role === 'user' ? message.text : 'اپراتور: ' + message.text,
      message.role === 'user' ? 'user' : 'bot');
  }
  cursor = data.messages.length;
  if (!data.active) {
    addMessage('این گفتگو بسته شد.');
    support.hidden = true;
    clearTimeout(timer);
  }
}

async function pollSupport(id, version) {
  try {
    const data = await supportRequest('/' + id);
    if (version !== generation) return;
    showSupportHistory(data);
    if (data.active) timer = setTimeout(() => pollSupport(id, version), 2200);
  } catch (error) {
    if (version === generation) addMessage(error.message);
  }
}

contact.addEventListener('click', () => {
  chat.hidden = true;
  contact.hidden = true;
  support.hidden = false;
  addMessage('خدمت موردنظر و پیام خود را وارد کنید. پیام در صف محلی اپراتور قرار می‌گیرد.');
  supportInput.focus();
});
support.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = supportInput.value.trim();
  if (!message || sending) return;
  sending = true;
  const version = generation;
  const existing = sessionId;
  clearTimeout(timer);
  try {
    if (existing) {
      const data = await supportRequest('/' + existing, { message });
      if (version !== generation) return;
      showSupportHistory(data);
    } else {
      const result = await supportRequest('', { channel: channel.value, message });
      if (version !== generation) return;
      sessionId = result.session_id;
      channel.disabled = true;
      addMessage('درخواست به صف اپراتور اضافه شد.');
    }
    supportInput.value = '';
  } catch (error) {
    if (version === generation) addMessage(error.message);
  } finally {
    sending = false;
    if (version === generation && sessionId && !support.hidden) pollSupport(sessionId, version);
  }
});
reset.addEventListener('click', () => {
  generation++;
  clearTimeout(timer);
  sessionId = undefined;
  cursor = 0;
  channel.disabled = false;
  support.hidden = true;
  supportInput.value = '';
  contact.hidden = false;
});
