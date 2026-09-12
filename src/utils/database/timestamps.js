/**
 * Shared converters for values that cross the Postgres TIMESTAMP boundary.
 * Consumers treat last_message-style fields as epoch milliseconds; the driver
 * may return Date objects or ISO strings.
 */

function fallbackDate(fallback) {
    if (fallback instanceof Date && !Number.isNaN(fallback.getTime())) {
        return fallback;
    }
    return new Date(0);
}

export function toDate(value, fallback = new Date(0)) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    if (value == null || value === '') {
        return fallbackDate(fallback);
    }

    if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
        const date = new Date(Number(value));
        return Number.isNaN(date.getTime()) ? fallbackDate(fallback) : date;
    }

    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? fallbackDate(fallback) : date;
    }

    const parsedDate = new Date(value);
    return Number.isNaN(parsedDate.getTime()) ? fallbackDate(fallback) : parsedDate;
}

export function toNonNegativeInt(value, fallback = 0) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) {
        return fallback;
    }
    return n;
}

export function toEpochMs(value, fallback = 0) {
    if (value == null || value === '') {
        return fallback;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getTime();
    }

    if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
