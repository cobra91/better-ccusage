function safeTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	}

	try {
		// Validate timezone by creating a formatter
		Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return timezone;
	}
	catch {
		return 'UTC';
	}
}

export function toDateKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: tz,
	});
	return formatter.format(date);
}

export function normalizeFilterDate(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}

	const compact = value.replaceAll('-', '').trim();
	if (!/^\d{8}$/.test(compact)) {
		throw new Error(`Invalid date format: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`);
	}

	return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * Determines whether a calendar date falls within an optional inclusive date range.
 *
 * The function compares dates after removing `-` characters, treating inputs as `YYYYMMDD`.
 *
 * @param dateKey - The date to test, in `YYYY-MM-DD` format.
 * @param since - Optional start of the inclusive range, in `YYYY-MM-DD` format.
 * @param until - Optional end of the inclusive range, in `YYYY-MM-DD` format.
 * @returns `true` if `dateKey` is within the inclusive range defined by `since` and `until`, `false` otherwise.
 */
export function isWithinRange(dateKey: string, since?: string, until?: string): boolean {
	const value = dateKey.replaceAll('-', '');
	const sinceValue = since?.replaceAll('-', '');
	const untilValue = until?.replaceAll('-', '');

	if (sinceValue != null && value < sinceValue) {
		return false;
	}

	if (untilValue != null && value > untilValue) {
		return false;
	}

	return true;
}

/**
 * Formats a calendar date (YYYY-MM-DD) into a locale-specific display string.
 *
 * @param dateKey - Calendar date in `YYYY-MM-DD` format; treated as a plain calendar date (no timezone shifting)
 * @param locale - Optional BCP 47 locale to use for formatting (defaults to `en-US`)
 * @param _timezone - Optional timezone argument (ignored; dateKey is assumed already localized)
 * @returns The formatted date string using an abbreviated month, two-digit day, and full year (e.g., "Mar 03, 2025")
 */
export function formatDisplayDate(dateKey: string, locale?: string, _timezone?: string): string {
	// dateKey is already computed for the target timezone via toDateKey().
	// Treat it as a plain calendar date and avoid shifting it by applying a timezone.
	const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		timeZone: 'UTC',
	});
	return formatter.format(date);
}

/**
 * Convert a timestamp into a month key formatted as YYYY-MM using the specified time zone.
 *
 * @param timestamp - A date/time string parseable by the JavaScript Date constructor
 * @param timezone - Optional IANA time zone identifier; if omitted or invalid, the environment's resolved time zone or `'UTC'` is used
 * @returns The month key in the form `YYYY-MM` for the timestamp in the resolved time zone
 */
export function toMonthKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		timeZone: tz,
	});
	const [year, month] = formatter.format(date).split('-');
	return `${year}-${month}`;
}

/**
 * Formats a calendar month key (YYYY-MM) into a locale-specific month string.
 *
 * The input `monthKey` is treated as a calendar month already derived for the target timezone (no timezone shifting is performed).
 *
 * @param monthKey - Month key in `YYYY-MM` format
 * @param locale - BCP 47 language tag to use for formatting; defaults to `en-US`
 * @param _timezone - Ignored; `monthKey` is assumed pre-derived for the desired timezone
 * @returns A localized month representation (for example, `Mar 2025`)
 */
export function formatDisplayMonth(monthKey: string, locale?: string, _timezone?: string): string {
	// monthKey is already derived in the target timezone via toMonthKey().
	// Render it as a calendar month without shifting by timezone.
	const [yearStr = '0', monthStr = '1'] = monthKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const date = new Date(Date.UTC(year, month - 1, 1));
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		timeZone: 'UTC',
	});
	return formatter.format(date);
}

export function formatDisplayDateTime(timestamp: string, locale?: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		dateStyle: 'short',
		timeStyle: 'short',
		timeZone: tz,
	});
	return formatter.format(date);
}