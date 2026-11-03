// moment-like date formatting for the small subset of tokens TSM users use.
const pad = (n, len = 2) => String(n).padStart(len, '0');

export function formatDate(value, format = 'YYYY.MM.DD HH:mm:ss') {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const h12 = d.getHours() % 12 || 12;
  const tokens = {
    YYYY: String(d.getFullYear()),
    YY: pad(d.getFullYear() % 100),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(h12),
    h: String(h12),
    mm: pad(d.getMinutes()),
    m: String(d.getMinutes()),
    ss: pad(d.getSeconds()),
    s: String(d.getSeconds()),
    A: d.getHours() < 12 ? 'AM' : 'PM',
    a: d.getHours() < 12 ? 'am' : 'pm',
    ddd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
  };
  return format.replace(/YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|A|a|ddd/g, (t) => tokens[t]);
}
