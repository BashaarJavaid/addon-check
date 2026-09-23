import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { CheckError } from './transport.js';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class UnsupportedSchema extends CheckError {}
const drafts = ['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema'];
const dialect = (value: unknown) => typeof value === 'string' ? value.replace(/#$/, '') : value;

function inspect(schema: unknown): void {
  if (!object(schema)) return;
  if (schema.$schema !== undefined && !drafts.includes(String(dialect(schema.$schema)))) throw new UnsupportedSchema('Unsupported JSON Schema dialect; untested');
  for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
    if (typeof schema[key] === 'string' && !schema[key].startsWith('#')) throw new UnsupportedSchema('External schema references are not fetched; untested');
  }
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
    if (object(schema[key])) Object.values(schema[key]).forEach(inspect);
  }
  if (object(schema.dependencies)) Object.values(schema.dependencies).filter(value => !Array.isArray(value)).forEach(inspect);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(schema[key])) schema[key].forEach(inspect);
  }
  for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
    const value = schema[key];
    if (Array.isArray(value)) value.forEach(inspect); else inspect(value);
  }
}
export function compile(schema: unknown): ValidateFunction {
  inspect(schema);
  if (!object(schema) || schema.type !== 'object') throw new CheckError('MCP schema must declare an object root');
  const options = {strict: false, validateFormats: false, logger: false as const, allErrors: false};
  const ajv = dialect(schema.$schema) === drafts[1] ? new Ajv(options) : new Ajv2020(options);
  try { return ajv.compile(schema); }
  catch { throw new CheckError('Invalid JSON Schema or unresolved local reference; schema details withheld'); }
}

export interface Case {
  tool: string;
  arguments: Record<string, unknown>;
  speechPointers: string[];
  repeatable: boolean;
  expectError: boolean;
  authProbe: boolean;
}
export function casesFile(value: unknown): Case[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.cases) || Object.keys(value).some(k => !['version', 'cases'].includes(k))) throw new CheckError('Cases file must contain version: 1 and cases');
  const keys = ['tool', 'arguments', 'speechPointers', 'repeatable', 'expectError', 'authProbe'];
  for (const entry of value.cases) {
    if (!object(entry) || Object.keys(entry).length !== keys.length || !keys.every(k => Object.hasOwn(entry, k)) || typeof entry.tool !== 'string' || !entry.tool || !object(entry.arguments) || !Array.isArray(entry.speechPointers) || !entry.speechPointers.every(p => typeof p === 'string' && (p === '' || p.startsWith('/')) && !/~(?:[^01]|$)/.test(p)) || !['repeatable', 'expectError', 'authProbe'].every(k => typeof entry[k] === 'boolean')) throw new CheckError('Each case needs all six explicit fields and valid JSON Pointers');
  }
  return value.cases as Case[];
}
export function speech(result: unknown, pointers: string[]): string[] {
  return pointers.flatMap(pointer => {
    let value = result;
    for (const key of pointer === '' ? [] : pointer.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (Array.isArray(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) throw new CheckError('Speech pointer does not resolve');
        value = value[Number(key)];
      } else if (object(value) && Object.hasOwn(value, key)) value = value[key];
      else throw new CheckError('Speech pointer does not resolve');
    }
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[];
    throw new CheckError('Selected speech must be a string or string array');
  });
}
export function speechMetrics(strings: string[]): {words: number; estimatedSeconds: number; formatting: boolean} {
  const words = strings.join(' ').match(/\S+/gu)?.length ?? 0;
  const formatting = strings.some(s => /[|`]|!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]+\]\[[^\]\n]*\]|^\s{0,3}#{1,6}\s|^\s*(?:[-+*]|\d+[.)])\s|(?<!\w)(\*{1,2}|_{1,2}|~~)(?=\S).+?\1(?!\w)/mu.test(s));
  return {words, estimatedSeconds: words / 2.5, formatting};
}
export function latencyPass(samples: number[]): boolean { return samples.length === 20 && samples.every(ms => ms < 500); }
