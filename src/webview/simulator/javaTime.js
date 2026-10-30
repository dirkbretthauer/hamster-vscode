/**
 * `java.util.Date` and `java.util.Calendar` value objects for the runtime
 * adapter. Both store an absolute instant as epoch milliseconds in
 * `__epochMillis`; that property is the contract the runner reads when a
 * `Date` is passed to `Timer.schedule(...)`. Field arithmetic uses the local
 * time zone, as `Calendar.getInstance()` does in the reference.
 */

/** Sentinel returned when a method is not part of the supported subset. */
export const TIME_METHOD_NOT_HANDLED = Symbol('timeMethodNotHandled');

/** `java.util.Calendar` field and value constants. */
export const CALENDAR_CONSTANTS = Object.freeze({
    ERA: 0, YEAR: 1, MONTH: 2, WEEK_OF_YEAR: 3, WEEK_OF_MONTH: 4,
    DATE: 5, DAY_OF_MONTH: 5, DAY_OF_YEAR: 6, DAY_OF_WEEK: 7, DAY_OF_WEEK_IN_MONTH: 8,
    AM_PM: 9, HOUR: 10, HOUR_OF_DAY: 11, MINUTE: 12, SECOND: 13, MILLISECOND: 14,
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5, JULY: 6,
    AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
    SUNDAY: 1, MONDAY: 2, TUESDAY: 3, WEDNESDAY: 4, THURSDAY: 5, FRIDAY: 6, SATURDAY: 7,
    AM: 0, PM: 1,
});

const C = CALENDAR_CONSTANTS;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const FIELD_NAMES = Object.freeze(Object.fromEntries(
    ['YEAR', 'MONTH', 'WEEK_OF_YEAR', 'WEEK_OF_MONTH', 'DAY_OF_MONTH', 'DAY_OF_YEAR', 'DAY_OF_WEEK',
        'DAY_OF_WEEK_IN_MONTH', 'AM_PM', 'HOUR', 'HOUR_OF_DAY', 'MINUTE', 'SECOND', 'MILLISECOND', 'ERA']
        .map(name => [C[name], name])));

const DATE_CLASS_NAMES = new Set(['Date', 'java.util.Date']);
const CALENDAR_CLASS_NAMES = new Set([
    'Calendar', 'java.util.Calendar', 'GregorianCalendar', 'java.util.GregorianCalendar',
]);

export function isDateClassName(className) {
    return DATE_CLASS_NAMES.has(className);
}

export function isCalendarClassName(className) {
    return CALENDAR_CLASS_NAMES.has(className);
}

/** True for any runtime value carrying an absolute instant (`Date` or `Calendar`). */
export function hasEpochMillis(value) {
    return Boolean(value) && typeof value === 'object' && typeof value.__epochMillis === 'number';
}

function requireMillis(value, what) {
    const millis = Number(value);
    if (!Number.isFinite(millis)) throw new Error(what + ' expects a time in milliseconds');
    return Math.trunc(millis);
}

function requireInstant(value, what) {
    if (!hasEpochMillis(value)) throw new Error(what + ' expects a Date or Calendar');
    return value.__epochMillis;
}

export function createJavaDate(epochMillis) {
    return {
        __kind: 'object',
        className: 'Date',
        __epochMillis: requireMillis(epochMillis, 'Date'),
        fields: Object.create(null),
    };
}

export function createJavaCalendar(epochMillis) {
    return {
        __kind: 'object',
        className: 'Calendar',
        __epochMillis: requireMillis(epochMillis, 'Calendar'),
        fields: Object.create(null),
    };
}

function compareInstants(left, right) {
    return Math.sign(left - right);
}

function callInstantComparison(receiver, methodName, args) {
    switch (methodName) {
        case 'before': return hasEpochMillis(args[0]) && receiver.__epochMillis < args[0].__epochMillis;
        case 'after': return hasEpochMillis(args[0]) && receiver.__epochMillis > args[0].__epochMillis;
        case 'equals':
            return hasEpochMillis(args[0]) && args[0].className === receiver.className &&
                args[0].__epochMillis === receiver.__epochMillis;
        case 'compareTo':
            return compareInstants(receiver.__epochMillis, requireInstant(args[0], receiver.className + '.compareTo'));
        case 'hashCode': return receiver.__epochMillis | 0;
        case 'toString': return new Date(receiver.__epochMillis).toString();
        default: return TIME_METHOD_NOT_HANDLED;
    }
}

export function callJavaDateMethod(receiver, methodName, args) {
    switch (methodName) {
        case 'getTime': return receiver.__epochMillis;
        case 'setTime':
            receiver.__epochMillis = requireMillis(args[0], 'Date.setTime');
            return undefined;
        default: return callInstantComparison(receiver, methodName, args);
    }
}

function dayOfYear(date) {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((startOfDay - startOfYear) / MILLIS_PER_DAY) + 1;
}

function unsupportedField(methodName, field) {
    return new Error('Calendar.' + methodName + ': field ' + (FIELD_NAMES[field] || field) +
        ' is not supported by the Hamster simulator');
}

function getCalendarField(date, field) {
    switch (field) {
        case C.ERA: return 1;
        case C.YEAR: return date.getFullYear();
        case C.MONTH: return date.getMonth();
        case C.DAY_OF_MONTH: return date.getDate();
        case C.DAY_OF_YEAR: return dayOfYear(date);
        case C.DAY_OF_WEEK: return date.getDay() + 1;
        case C.DAY_OF_WEEK_IN_MONTH: return Math.floor((date.getDate() - 1) / 7) + 1;
        case C.AM_PM: return date.getHours() < 12 ? C.AM : C.PM;
        case C.HOUR: return date.getHours() % 12;
        case C.HOUR_OF_DAY: return date.getHours();
        case C.MINUTE: return date.getMinutes();
        case C.SECOND: return date.getSeconds();
        case C.MILLISECOND: return date.getMilliseconds();
        default: throw unsupportedField('get', field);
    }
}

/** Lenient like Java's default calendar: out-of-range values roll into the next unit. */
function setCalendarField(date, field, value) {
    switch (field) {
        case C.YEAR: date.setFullYear(value); return;
        case C.MONTH: date.setMonth(value); return;
        case C.DAY_OF_MONTH: date.setDate(value); return;
        case C.DAY_OF_YEAR: date.setMonth(0, value); return;
        case C.DAY_OF_WEEK: date.setDate(date.getDate() + (value - 1 - date.getDay())); return;
        case C.AM_PM: date.setHours(date.getHours() % 12 + (value === C.PM ? 12 : 0)); return;
        case C.HOUR: date.setHours((date.getHours() < 12 ? 0 : 12) + value); return;
        case C.HOUR_OF_DAY: date.setHours(value); return;
        case C.MINUTE: date.setMinutes(value); return;
        case C.SECOND: date.setSeconds(value); return;
        case C.MILLISECOND: date.setMilliseconds(value); return;
        default: throw unsupportedField('set', field);
    }
}

function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

/** Like Java, adding months/years keeps the day of month but clamps it to the target month's length. */
function addMonths(date, months) {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    date.setDate(Math.min(day, daysInMonth(date.getFullYear(), date.getMonth())));
}

function addCalendarField(date, field, amount) {
    switch (field) {
        case C.YEAR: addMonths(date, amount * 12); return;
        case C.MONTH: addMonths(date, amount); return;
        case C.WEEK_OF_YEAR:
        case C.WEEK_OF_MONTH: date.setDate(date.getDate() + amount * 7); return;
        case C.DAY_OF_MONTH:
        case C.DAY_OF_YEAR:
        case C.DAY_OF_WEEK: date.setDate(date.getDate() + amount); return;
        case C.AM_PM: date.setHours(date.getHours() + amount * 12); return;
        case C.HOUR:
        case C.HOUR_OF_DAY: date.setHours(date.getHours() + amount); return;
        case C.MINUTE: date.setMinutes(date.getMinutes() + amount); return;
        case C.SECOND: date.setSeconds(date.getSeconds() + amount); return;
        case C.MILLISECOND: date.setMilliseconds(date.getMilliseconds() + amount); return;
        default: throw unsupportedField('add', field);
    }
}

function requireInteger(value, what) {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error(what + ' expects integer arguments');
    return number;
}

function updateCalendar(receiver, mutate) {
    const date = new Date(receiver.__epochMillis);
    mutate(date);
    receiver.__epochMillis = date.getTime();
}

/** `set(year, month, date[, hourOfDay, minute[, second]])` leaves unspecified fields unchanged. */
function setCalendarDate(receiver, args) {
    const values = args.map(arg => requireInteger(arg, 'Calendar.set'));
    updateCalendar(receiver, date => {
        date.setFullYear(values[0], values[1], values[2]);
        if (values.length >= 5) date.setHours(values[3], values[4]);
        if (values.length === 6) date.setSeconds(values[5]);
    });
}

export function callJavaCalendarMethod(receiver, methodName, args) {
    switch (methodName) {
        case 'get':
            return getCalendarField(new Date(receiver.__epochMillis), requireInteger(args[0], 'Calendar.get'));
        case 'set':
            if (args.length === 2) {
                const field = requireInteger(args[0], 'Calendar.set');
                const value = requireInteger(args[1], 'Calendar.set');
                updateCalendar(receiver, date => setCalendarField(date, field, value));
                return undefined;
            }
            if (args.length === 3 || args.length === 5 || args.length === 6) {
                setCalendarDate(receiver, args);
                return undefined;
            }
            throw new Error('Calendar.set expects (field, value) or (year, month, date[, hour, minute[, second]])');
        case 'add': {
            const field = requireInteger(args[0], 'Calendar.add');
            const amount = requireInteger(args[1], 'Calendar.add');
            updateCalendar(receiver, date => addCalendarField(date, field, amount));
            return undefined;
        }
        case 'getTime': return createJavaDate(receiver.__epochMillis);
        case 'setTime':
            receiver.__epochMillis = requireInstant(args[0], 'Calendar.setTime');
            return undefined;
        case 'getTimeInMillis': return receiver.__epochMillis;
        case 'setTimeInMillis':
            receiver.__epochMillis = requireMillis(args[0], 'Calendar.setTimeInMillis');
            return undefined;
        case 'clone': return createJavaCalendar(receiver.__epochMillis);
        default: return callInstantComparison(receiver, methodName, args);
    }
}
