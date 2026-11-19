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
const examplePrice = 1200000;
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
  addMessage([
    'خلاصه سفر فرضی',
    `مسیر: ${trip.origin} به ${trip.destination}`,
    `تاریخ: ${trip.date}`,
    `مسافران: ${format.format(trip.count)} نفر`,
    `مبلغ کاملا فرضی: ${format.format(examplePrice * trip.count)} تومان`,
  ].join('\n'), 'bot', true);
  chat.hidden = true;
  reset.focus();
});

reset.addEventListener('click', () => {
  start();
  input.focus();
});
start();
