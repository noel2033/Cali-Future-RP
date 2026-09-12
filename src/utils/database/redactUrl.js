const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/[^:@\s/]+):([^@\s/]+)@/gi;

export function redactDatabaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return '[redacted]';
  }

  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return redactDatabaseSecrets(url) || '[redacted]';
  }
}

export function redactDatabaseSecrets(text) {
  if (typeof text !== 'string') {
    return text;
  }

  return text.replace(POSTGRES_CREDENTIALS, '$1:***@');
}
