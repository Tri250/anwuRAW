import { ImageFile } from '../components/ui/AppProperties';

/**
 * Smart albums: saved filter rules evaluated live over the library. Rules are
 * frontend-owned (see libraryUserData.ts for why they are not persisted in
 * the backend settings struct) and evaluated against the image list plus the
 * EXIF map that the library already loads.
 */

export type SmartRuleField =
  | 'rating'
  | 'flag'
  | 'edited'
  | 'raw'
  | 'color'
  | 'camera'
  | 'lens'
  | 'iso'
  | 'dateTaken'
  | 'filename';

export interface SmartRule {
  field: SmartRuleField;
  op: string;
  value: string;
}

export interface SmartAlbum {
  type: 'smart';
  id: string;
  name: string;
  match: 'all' | 'any';
  rules: SmartRule[];
}

export interface SmartAlbumInput {
  image: ImageFile;
  exif: Record<string, string> | null | undefined;
  rating: number;
}

const parseDateValue = (value: string): number | null => {
  const time = Date.parse(value);
  return isNaN(time) ? null : time;
};

const exifDateTime = (exif: Record<string, string> | null | undefined): string =>
  exif?.DateTimeOriginal || exif?.CreateDate || '';

const parseIsoNumber = (exif: Record<string, string> | null | undefined): number =>
  parseInt(exif?.PhotographicSensitivity || exif?.ISOSpeedRatings || '0', 10) || 0;

export const SMART_RULE_FIELDS: SmartRuleField[] = [
  'rating',
  'flag',
  'edited',
  'raw',
  'color',
  'camera',
  'lens',
  'iso',
  'dateTaken',
  'filename',
];

const OPS_BY_FIELD: Record<SmartRuleField, string[]> = {
  rating: ['gte', 'eq', 'lte'],
  flag: ['is'],
  edited: ['is'],
  raw: ['is'],
  color: ['is'],
  camera: ['contains'],
  lens: ['contains'],
  iso: ['gte', 'lte'],
  dateTaken: ['on', 'after', 'before'],
  filename: ['contains'],
};

export const getRuleOps = (field: SmartRuleField): string[] => OPS_BY_FIELD[field] ?? ['contains'];

export function evaluateSmartRule(rule: SmartRule, input: SmartAlbumInput): boolean {
  const { image, exif, rating } = input;
  const value = rule.value.trim().toLowerCase();

  switch (rule.field) {
    case 'rating': {
      const target = parseInt(value, 10);
      if (isNaN(target)) return true;
      if (rule.op === 'eq') return rating === target;
      if (rule.op === 'lte') return rating <= target;
      return rating >= target;
    }
    case 'flag': {
      if (value === 'none') return image.flag === null || image.flag === undefined;
      return image.flag === value;
    }
    case 'edited':
      return value === 'unedited' ? !image.is_edited : image.is_edited;
    case 'raw':
      return value === 'nonRaw' ? !image.is_raw : image.is_raw;
    case 'color': {
      const color = (image.tags || []).find((tag) => tag.startsWith('color:'))?.substring(6) || 'none';
      return color.toLowerCase() === value;
    }
    case 'camera': {
      const camera = `${exif?.Make || ''} ${exif?.Model || ''}`.trim().toLowerCase();
      return camera.includes(value);
    }
    case 'lens': {
      const lens = `${exif?.LensModel || ''} ${exif?.Lens || ''}`.trim().toLowerCase();
      return lens.includes(value);
    }
    case 'iso': {
      const target = parseInt(value, 10);
      if (isNaN(target)) return true;
      const iso = parseIsoNumber(exif);
      return rule.op === 'lte' ? iso <= target : iso >= target;
    }
    case 'dateTaken': {
      const taken = exifDateTime(exif);
      const imageTime = parseDateValue(taken);
      const ruleTime = parseDateValue(value);
      if (imageTime === null || ruleTime === null) return false;
      const imageDay = new Date(imageTime).setHours(0, 0, 0, 0);
      const ruleDay = new Date(ruleTime).setHours(0, 0, 0, 0);
      if (rule.op === 'on') return imageDay === ruleDay;
      if (rule.op === 'before') return imageDay < ruleDay;
      return imageDay >= ruleDay;
    }
    case 'filename': {
      const name = image.path.split('?vc=')[0].split(/[\\/]/).pop()?.toLowerCase() || '';
      return name.includes(value);
    }
    default:
      return true;
  }
}

export function matchesSmartAlbum(album: SmartAlbum, input: SmartAlbumInput): boolean {
  if (album.rules.length === 0) return false;
  const results = album.rules.map((rule) => evaluateSmartRule(rule, input));
  return album.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export function filterImagesForAlbum(
  album: SmartAlbum,
  images: ImageFile[],
  exifByPath: Record<string, Record<string, string>>,
  imageRatings: Record<string, number>,
): ImageFile[] {
  return images.filter((image) =>
    matchesSmartAlbum(album, {
      image,
      exif: exifByPath[image.path] ?? image.exif,
      rating: imageRatings[image.path] ?? image.rating ?? 0,
    }),
  );
}
