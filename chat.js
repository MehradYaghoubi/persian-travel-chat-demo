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
