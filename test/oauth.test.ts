import { describe, expect, it } from 'vitest';
import {
	authorizeUrl,
	fieldsFromProtocol,
	isExpired,
	newState,
	parseAuthorizationResponse,
} from '../src/oauth';

const NOW = Date.UTC(2026, 8, 18);
const STATE = 'abc123';

describe('authorizeUrl', () => {
	it('asks for a token with every documented scope but email', () => {
		const url = new URL(authorizeUrl('client-1', STATE));
		expect(url.origin + url.pathname).toBe('https://cloud.ouraring.com/oauth/authorize');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: 'token',
			client_id: 'client-1',
			redirect_uri: 'obsidian://oura-metrics',
			scope: 'daily personal heartrate workout tag session spo2 heart_health',
			state: STATE,
		});
	});
});

describe('newState', () => {
	it('is 32 hex characters and differs each call', () => {
		const a = newState();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(newState()).not.toBe(a);
	});
});

describe('fieldsFromProtocol', () => {
	// What Obsidian 1.13 hands the handler for
	// obsidian://oura-metrics#access_token=tok%2Fen&token_type=bearer&expires_in=2592000&scope=daily&state=abc123
	it('reads the raw fragment Obsidian passes as `hash`', () => {
		const fields = fieldsFromProtocol({
			action: 'oura-metrics',
			hash: 'access_token=tok%2Fen&token_type=bearer&expires_in=2592000&scope=daily&state=abc123',
		});
		expect(fields.get('access_token')).toBe('tok/en');
		expect(fields.get('state')).toBe(STATE);
		expect(fields.has('action')).toBe(false);
	});

	it('reads an error delivered in the query', () => {
		const fields = fieldsFromProtocol({ action: 'oura-metrics', error: 'access_denied', state: STATE });
		expect(fields.get('error')).toBe('access_denied');
	});
});

describe('parseAuthorizationResponse', () => {
	const ok = (over: Record<string, string> = {}) =>
		new URLSearchParams({
			access_token: 'tok',
			token_type: 'bearer',
			expires_in: '2592000',
			scope: 'daily',
			state: STATE,
			...over,
		});

	it('returns the token and its expiry', () => {
		expect(parseAuthorizationResponse(ok(), STATE, NOW)).toEqual({
			accessToken: 'tok',
			expiresAt: NOW + 2592000 * 1000,
		});
	});

	it('records an unknown expiry as 0', () => {
		const fields = ok();
		fields.delete('expires_in');
		expect(parseAuthorizationResponse(fields, STATE, NOW).expiresAt).toBe(0);
	});

	// A grant without daily surfaces as a 403 from the API, not here.
	it('leaves scope to the API', () => {
		expect(() => parseAuthorizationResponse(ok({ scope: 'extapi:personal' }), STATE, NOW)).not.toThrow();
	});

	it('rejects a mismatched state', () => {
		expect(() => parseAuthorizationResponse(ok({ state: 'other' }), STATE, NOW)).toThrow(/doesn’t match/);
	});

	it('rejects a missing state', () => {
		const fields = ok();
		fields.delete('state');
		expect(() => parseAuthorizationResponse(fields, STATE, NOW)).toThrow(/doesn’t match/);
	});

	it('rejects any response when no connection was started', () => {
		expect(() => parseAuthorizationResponse(ok(), '', NOW)).toThrow(/Click Connect first/);
	});

	// The fields Oura actually sends (September 2026), in its order.
	it('accepts Oura’s real response, with its expiry', () => {
		const fields = fieldsFromProtocol({
			action: 'oura-metrics',
			hash: 'access_token=tok&scope=x&claims=y&iss=z&state=abc123&token_type=bearer&expires_in=2591999',
		});
		expect(parseAuthorizationResponse(fields, STATE, NOW)).toEqual({
			accessToken: 'tok',
			expiresAt: NOW + 2591999 * 1000,
		});
	});

	it('rejects a token that isn’t a bearer token', () => {
		expect(() => parseAuthorizationResponse(ok({ token_type: 'mac' }), STATE, NOW)).toThrow(/bearer/);
	});

	it('explains a denial', () => {
		const fields = new URLSearchParams({ error: 'access_denied', state: STATE });
		expect(() => parseAuthorizationResponse(fields, STATE, NOW)).toThrow(/denied/);
	});

	it('explains a reply with no token', () => {
		expect(() => parseAuthorizationResponse(new URLSearchParams({ state: STATE }), STATE, NOW)).toThrow(
			/no access token/,
		);
	});
});

describe('isExpired', () => {
	it('treats 0 as unknown, not expired', () => {
		expect(isExpired(0, NOW)).toBe(false);
		expect(isExpired(NOW - 1, NOW)).toBe(true);
		expect(isExpired(NOW + 1, NOW)).toBe(false);
	});
});
