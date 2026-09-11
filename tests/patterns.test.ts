import { describe, it, expect } from 'vitest';
import { isValidLuhn, PATTERNS, matchesKeyword, KEYWORDS } from '../extension/src/privacy/patterns';

describe('PrivAgent Patterns & Heuristics', () => {
  describe('Luhn Algorithm (Credit/Debit Card Validation)', () => {
    it('should validate synthetic Visa card (4111 1111 1111 1111)', () => {
      expect(isValidLuhn('4111 1111 1111 1111')).toBe(true);
      expect(isValidLuhn('4111-1111-1111-1111')).toBe(true);
      expect(isValidLuhn('4111111111111111')).toBe(true);
    });

    it('should reject invalid card numbers with incorrect checksum', () => {
      expect(isValidLuhn('4111 1111 1111 1112')).toBe(false);
      expect(isValidLuhn('1234 5678 9012 3456')).toBe(false);
      expect(isValidLuhn('123')).toBe(false);
    });
  });

  describe('Email Regex Validation', () => {
    it('should match synthetic emails', () => {
      const text = 'Contact: rahul.sharma@example.com for info.';
      const matches = text.match(PATTERNS.EMAIL);
      expect(matches).not.toBeNull();
      expect(matches![0]).toBe('rahul.sharma@example.com');
    });

    it('should match vendor email addresses', () => {
      const text = 'vikram.lab@synthetic-vendor.in';
      expect(PATTERNS.EMAIL.test(text)).toBe(true);
    });
  });

  describe('Phone Regex Validation', () => {
    it('should match Indian 10-digit mobile numbers', () => {
      const text = '9876543210';
      expect(PATTERNS.PHONE.test(text)).toBe(true);
    });

    it('should match +91 prefixed phone numbers', () => {
      const text = '+91 9876543210';
      expect(PATTERNS.PHONE.test(text)).toBe(true);
    });
  });

  describe('Keyword Heuristics', () => {
    it('should detect password keywords in various casings and substrings', () => {
      expect(matchesKeyword('user_password', KEYWORDS.PASSWORD)).toBe(true);
      expect(matchesKeyword('txtCurrentPin', KEYWORDS.PASSWORD)).toBe(true);
      expect(matchesKeyword('cvv_code', KEYWORDS.PASSWORD)).toBe(true);
      expect(matchesKeyword('username', KEYWORDS.PASSWORD)).toBe(false);
    });

    it('should detect credit card and account keywords', () => {
      expect(matchesKeyword('card_number', KEYWORDS.CREDIT_CARD)).toBe(true);
      expect(matchesKeyword('bank_acc_num', KEYWORDS.ACCOUNT_NUMBER)).toBe(true);
      expect(matchesKeyword('routing_number', KEYWORDS.ACCOUNT_NUMBER)).toBe(false);
    });
  });
});
