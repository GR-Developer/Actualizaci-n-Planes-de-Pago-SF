// Todo en UTC para evitar corrimientos por zona horaria

function parseFecha(str) {
    const [y, m, d] = str.slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function formatFecha(date) {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Suma meses ajustando el día (31-ene + 1 mes = 28/29-feb)
function addMonths(date, n) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + n;
    const d = date.getUTCDate();
    const ultimoDia = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(d, ultimoDia)));
}

// Suma meses pero siempre intenta poner el día indicado (diaConcurrente).
// Si el mes no tiene tantos días, usa el último día del mes.
// Garantiza que si diaConcurrente=5, todos los meses den día 5,
// sin arrastrar un clamp de un mes corto (ej. Feb 28 → Mar 28 en vez de Mar 5).
function addMonthsWithDay(date, n, diaConcurrente) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + n;
    const ultimoDia = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(diaConcurrente, ultimoDia)));
}

// "2026-03" para comparar por mes
function mesKey(date) {
    return formatFecha(date).slice(0, 7);
}

module.exports = { parseFecha, formatFecha, addMonths, addMonthsWithDay, mesKey };