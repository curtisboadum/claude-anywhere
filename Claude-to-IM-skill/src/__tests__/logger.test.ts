/**
 * @file logger.test.ts
 * @description Tests log secret redaction across key/value, bare Telegram token,
 *   URL-embedded token, Bearer, and additional key names.
 * @status Modified (harden/worktree-isolation): added bare/URL token + key shapes.
 * @issues none known.
 * @todo none.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../logger.js';

describe('maskSecrets', () => {
  it('masks token=value patterns', () => {
    const input = 'token=secret123456789';
    const result = maskSecrets(input);
    assert.notEqual(result, input);
    // Should not contain the full token
    assert.ok(!result.includes('secret123456789'));
  });

  it('masks secret=value patterns', () => {
    const input = 'secret=my-secret-value';
    const result = maskSecrets(input);
    assert.ok(!result.includes('my-secret-value'));
  });

  it('masks password=value patterns', () => {
    const input = 'password=hunter2abc';
    const result = maskSecrets(input);
    assert.ok(!result.includes('hunter2abc'));
  });

  it('masks api_key=value patterns', () => {
    const input = 'api_key=sk-abcdef123456';
    const result = maskSecrets(input);
    assert.ok(!result.includes('sk-abcdef123456'));
  });

  it('masks Telegram bot token format', () => {
    const input = 'Using bot token bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a';
    const result = maskSecrets(input);
    assert.ok(!result.includes('bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a'));
  });

  it('masks a bare Telegram bot token (no "bot" prefix)', () => {
    const token = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a';
    const input = `CTI_TG_BOT_TOKEN value is ${token} loaded`;
    const result = maskSecrets(input);
    assert.ok(!result.includes(token), 'bare token must be masked');
  });

  it('masks a Telegram token embedded in an API URL', () => {
    const token = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a';
    const input = `GET https://api.telegram.org/bot${token}/getUpdates failed`;
    const result = maskSecrets(input);
    assert.ok(!result.includes(token), 'URL-embedded token must be masked');
  });

  it('masks context_token and app_secret key names', () => {
    assert.ok(!maskSecrets('context_token=ctx-abc-123456').includes('ctx-abc-123456'));
    assert.ok(!maskSecrets('app_secret: feishu-supersecret-xyz').includes('feishu-supersecret-xyz'));
  });

  it('masks Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.signature';
    const result = maskSecrets(input);
    assert.ok(!result.includes('Bearer eyJhbGciOiJIUzI1NiJ9.test.signature'));
  });

  it('leaves normal text unchanged', () => {
    const input = 'Starting bridge on port 8080';
    assert.equal(maskSecrets(input), input);
  });

  it('preserves last 4 chars of masked values', () => {
    const input = 'token=abcdefghijklmnop';
    const result = maskSecrets(input);
    // The last 4 chars of the matched portion should be visible
    assert.ok(result.includes('mnop'));
  });

  it('handles quoted values', () => {
    const input = 'token="my-secret-token"';
    const result = maskSecrets(input);
    assert.ok(!result.includes('my-secret-token'));
  });
});
