// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

const encoder = new TextEncoder();
// A leading BOM belongs to file content and must survive a round trip.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Encode text or preserve an existing byte view. */
export const getBytes = (data: string | Uint8Array): Uint8Array => {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  throw new TypeError('Expected a string or Uint8Array');
};

/** Decode UTF-8 without removing a leading BOM. */
export const decodeBytes = (data: Uint8Array): string => decoder.decode(data);

/** Concatenate byte views into an owned array. */
export const concatBytes = (
  chunks: readonly Uint8Array[],
  total: number
): Uint8Array => {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/** Validate the nonnegative eleven-octal-digit ustar content size. */
export const validateLength = (length: number): void => {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0o77777777777) {
    throw new RangeError(
      'Invalid content length: expected an integer from 0 to 8589934591'
    );
  }
};

/** Write a UTF-8 field without splitting a Unicode code point. */
export const writeText = (
  target: Uint8Array,
  text: string,
  offset: number,
  length: number
): void => {
  encoder.encodeInto(text, target.subarray(offset, offset + length));
};
