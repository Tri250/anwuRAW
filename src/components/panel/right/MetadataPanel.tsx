import { useState, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, ChevronDown, ChevronRight, Plus, Star, Tag, X, User } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Invokes } from '../../ui/AppProperties';
import { COLOR_LABELS, COLOR_LABEL_SHORTCUT, Color } from '../../../utils/adjustments';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { IconAperture, IconShutter, IconIso, IconFocalLength, IconLens } from '../editor/ExifIcons';
import { useEditorStore } from '../../../store/useEditorStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useLibraryActions } from '../../../hooks/useLibraryActions';
import { expandGroupedPaths } from '../../../utils/imageGrouping';

interface CameraSetting {
  format?(value: number): string | number;
  label: string;
}

interface CameraSettings {
  [index: string]: CameraSetting;
  ExposureTime: CameraSetting;
  FNumber: CameraSetting;
  FocalLengthIn35mmFilm: CameraSetting;
  LensModel: CameraSetting;
  PhotographicSensitivity: CameraSetting;
}

interface GPSData {
  altitude: number | null;
  lat: number | null;
  lon: number | null;
}

interface MetaDataItemProps {
  label: string;
  value: any;
}

const USER_TAG_PREFIX = 'user:';
const EMPTY_TAGS: string[] = [];

/** EXIF 标准标签中文映射表（ISO/IEC 15434 / EXIF 2.32） */
const EXIF_TAG_ZH: Record<string, string> = {
  // 图像基础
  ImageWidth: '图像宽度',
  ImageHeight: '图像高度',
  BitsPerSample: '采样位数',
  SamplesPerPixel: '通道数',
  PhotometricInterpretation: '色彩空间表示',
  Compression: '压缩方式',
  Orientation: '旋转方向',
  XResolution: '水平分辨率',
  YResolution: '垂直分辨率',
  ResolutionUnit: '分辨率单位',
  PlanarConfiguration: '平面配置',
  YCbCrPositioning: 'YCbCr 位置',
  Copyright: '版权',
  Artist: '作者',
  ImageDescription: '图像描述',
  Make: '相机厂商',
  Model: '相机型号',
  Software: '软件',
  HostComputer: '主机',
  DateTime: '时间',
  DateTimeOriginal: '拍摄时间',
  DateTimeDigitized: '数字化时间',
  SubsecTimeOriginal: '亚秒时间（原）',
  SubsecTimeDigitized: '亚秒时间（数）',
  SubsecTime: '亚秒时间',
  ExifVersion: 'EXIF 版本',
  FlashPixVersion: 'FlashPix 版本',
  ColorSpace: '色彩空间',
  UserComment: '用户注释',
  UserCommentEN: '用户注释编码',
  RelatedSoundFile: '关联声音文件',
  ExifImageWidth: 'EXIF 图像宽度',
  ExifImageHeight: 'EXIF 图像高度',
  FocalPlaneXResolution: '焦平面水平分辨率',
  FocalPlaneYResolution: '焦平面垂直分辨率',
  FocalPlaneResolutionUnit: '焦平面分辨率单位',
  ExposureIndex: '曝光指数',
  SensingMethod: '感光方式',
  FileSource: '文件来源',
  SceneType: '场景类型',
  CustomRendered: '自定义渲染',
  ExposureMode: '曝光模式',
  WhiteBalance: '白平衡',
  DigitalZoomRatio: '数字变焦比',
  FocalLengthIn35mmFilm: '35mm 等效焦距',
  SceneCaptureType: '场景拍摄类型',
  GainControl: '增益控制',
  Contrast: '对比度',
  Saturation: '饱和度',
  Sharpness: '锐度',
  DeviceSettingDescription: '设备设置描述',
  SubjectDistanceRange: '主体距离范围',
  ImageUniqueID: '图像唯一 ID',
  LensMake: '镜头厂商',
  LensModel: '镜头型号',
  LensSerialNumber: '镜头序列号',
  FocalLength: '焦距',
  FNumber: '光圈',
  ExposureTime: '曝光时间',
  PhotographicSensitivity: 'ISO 感光度',
  RecommendedExposureIndex: '推荐曝光指数',
  ISOSpeedRatings: 'ISO 速度评级',
  ISOSpeed: 'ISO 速度',
  ISOSpeedLatitudeyyy: 'ISO 速度纬度 yyy',
  ISOSpeedLatitudezzz: 'ISO 速度纬度 zzz',
  ExifBias: '曝光偏差',
  MeteringMode: '测光模式',
  Flash: '闪光灯',
  FlashEnergy: '闪光强度',
  FlashStrobepresent: '闪光灯状态',
  FlashReturnedLight: '闪光返回光',
  FlashMode: '闪光模式',
  RedEyeMode: '红眼消除',
  WhiteBalanceMode: '白平衡模式',
  CaptureMode: '拍摄模式',
  ExposureProgram: '曝光程序',
  ProgramMode: '程序模式',
  LensSpecification: '镜头规格',
  LensID: '镜头 ID',
  LensInfo: '镜头信息',
  FlashPix: 'FlashPix',
  InteroperabilityIndex: '互操作索引',
  InteroperabilityVersion: '互操作版本',
  InteroperabilityRelatedImageFile: '互操作关联图像文件',
  ThumbnailOffset: '缩略图偏移',
  ThumbnailLength: '缩略图长度',
  StripOffsets: '行偏移',
  RowsPerStrip: '每行条数',
  StripByteCounts: '行字节数',
  TileWidth: '块宽度',
  TileLength: '块长度',
  TileOffsets: '块偏移',
  TileByteCounts: '块字节数',
  JPEGInterchangeFormat: 'JPEG 交换格式',
  JPEGInterchangeFormatLength: 'JPEG 交换格式长度',
  GPSLatitudeRef: 'GPS 纬度参照',
  GPSLatitude: 'GPS 纬度',
  GPSLongitudeRef: 'GPS 经度参照',
  GPSLongitude: 'GPS 经度',
  GPSAltitudeRef: 'GPS 海拔参照',
  GPSAltitude: 'GPS 海拔',
  GPSTimeStamp: 'GPS 时间戳',
  GPSSatellites: 'GPS 卫星',
  GPSStatus: 'GPS 状态',
  GPSMeasureMode: 'GPS 测量模式',
  GPSDOP: 'GPS DOP',
  GPSSpeedRef: 'GPS 速度参照',
  GPSSpeed: 'GPS 速度',
  GPSTrackRef: 'GPS 轨迹参照',
  GPSTrack: 'GPS 轨迹',
  GPSImgDirectionRef: 'GPS 图像方向参照',
  GPSImgDirection: 'GPS 图像方向',
  GPSMapDatum: 'GPS 地图基准',
  GPSDestLatitudeRef: 'GPS 目标纬度参照',
  GPSDestLatitude: 'GPS 目标纬度',
  GPSDestLongitudeRef: 'GPS 目标经度参照',
  GPSDestLongitude: 'GPS 目标经度',
  GPSDestBearingRef: 'GPS 目标方位参照',
  GPSDestBearing: 'GPS 目标方位',
  GPSDestDistanceRef: 'GPS 目标距离参照',
  GPSDestDistance: 'GPS 目标距离',
  GPSProcessingMethod: 'GPS 处理方法',
  GPSAreaInformation: 'GPS 区域信息',
  GPSDateStamp: 'GPS 日期戳',
  GPSDifferential: 'GPS 差分',
  Hint: '提示',
  Padding: '填充',
};

function formatExifTag(str: string) {
  if (!str) return '';
  // 优先查找中文映射
  if (EXIF_TAG_ZH[str]) return EXIF_TAG_ZH[str];
  // user: 前缀的标签保持原样
  if (str.startsWith(USER_TAG_PREFIX)) return str.slice(USER_TAG_PREFIX.length);
  // 驼峰 → 空格
  return str.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

function parseDms(dmsString: string) {
  if (!dmsString) return null;
  const parts = dmsString.match(/(\d+\.?\d*)\s+deg\s+(\d+\.?\d*)\s+min\s+(\d+\.?\d*)\s+sec/);
  if (!parts) return null;
  const degrees = parseFloat(parts[1]);
  const minutes = parseFloat(parts[2]);
  const seconds = parseFloat(parts[3]);
  return degrees + minutes / 60 + seconds / 3600;
}

const CAMERA_ICONS: Record<string, React.FC> = {
  FNumber: IconAperture,
  ExposureTime: IconShutter,
  PhotographicSensitivity: IconIso,
  FocalLengthIn35mmFilm: IconFocalLength,
  LensModel: IconLens,
};

function MetadataItem({ label, value }: MetaDataItemProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const strValue = String(value);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(strValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  return (
    <div className="flex justify-between items-start gap-4 py-1.5 px-2 rounded-md hover:bg-card-active transition-colors cursor-default">
      <Text
        variant={TextVariants.body}
        color={TextColors.secondary}
        weight={TextWeights.medium}
        className="shrink-0 mt-0.5 max-w-none min-w-0 break-all sm:break-words"
      >
        {label}
      </Text>
      <div
        className="grid cursor-pointer text-right min-w-0 flex-1"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setCopied(false);
        }}
        onClick={handleCopy}
        data-tooltip={strValue.length > 500 ? strValue.slice(0, 500) + '...' : strValue}
      >
        <Text
          variant={TextVariants.body}
          color={TextColors.primary}
          className={clsx(
            'col-start-1 row-start-1 break-words min-w-0 text-right text-[13px] leading-snug line-clamp-3 transition-opacity duration-200 ease-in-out select-none',
            isHovered ? 'opacity-0' : 'opacity-100',
          )}
        >
          {strValue}
        </Text>
        <span
          aria-hidden={!isHovered}
          className={clsx(
            'col-start-1 row-start-1 text-xs font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none flex items-center justify-end h-full',
            isHovered ? 'opacity-100' : 'opacity-0',
          )}
        >
          {copied ? t('editor.metadata.copied') : t('editor.metadata.copy')}
        </span>
      </div>
    </div>
  );
}

interface EditableMetadataItemProps {
  label: string;
  value: string;
  onSave: (val: string) => void;
}

function EditableMetadataItem({ label, value, onSave }: EditableMetadataItemProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [localValue, setLocalValue] = useState(value || '');

  useEffect(() => {
    setLocalValue(value || '');
    setIsEditing(false);
  }, [value]);

  const handleSave = () => {
    setIsEditing(false);
    const trimmedLocal = localValue.trim();
    const trimmedProp = (value || '').trim();
    if (trimmedLocal !== trimmedProp) {
      onSave(trimmedLocal);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setLocalValue(value || '');
      setIsEditing(false);
    }
  };

  return (
    <div className="flex justify-between items-center gap-4 py-1 px-2 rounded-md">
      <Text
        variant={TextVariants.small}
        color={TextColors.secondary}
        weight={TextWeights.medium}
        className="shrink-0 truncate"
      >
        {label}
      </Text>

      <div className="w-[55%] shrink-0">
        {isEditing ? (
          <input
            autoFocus
            type="text"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className="bg-bg-secondary border border-accent rounded-sm px-2 py-0.5 text-xs text-text-primary text-right outline-hidden w-full shadow-sm focus:ring-1 focus:ring-accent/30"
          />
        ) : (
          <div
            onClick={() => setIsEditing(true)}
            className="text-xs px-2 py-0.5 min-h-[24px] flex items-center justify-end rounded-sm cursor-text border transition-colors text-right truncate w-full text-text-primary bg-bg-secondary/40 border-surface/50 hover:bg-bg-secondary/80 hover:border-text-tertiary/40"
            data-tooltip={value ? t('editor.metadata.clickToEdit') : t('editor.metadata.emptyClickToAdd')}
          >
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

const EDITABLE_FIELDS = [
  { key: 'ImageDescription', label: 'title' },
  { key: 'Artist', label: 'author' },
  { key: 'Copyright', label: 'copyright' },
  { key: 'UserComment', label: 'comments' },
];

const KEY_CAMERA_SETTINGS_MAP: CameraSettings = {
  FNumber: {
    format: (value: number) => {
      const fStr = String(value);
      return fStr.toLowerCase().startsWith('f') ? fStr : `f/${fStr}`;
    },
    label: 'Aperture',
  },
  ExposureTime: {
    format: (value: number) => (String(value).endsWith('s') ? value : `${value}s`),
    label: 'Shutter Speed',
  },
  PhotographicSensitivity: {
    format: (value: number) => `${value}`,
    label: 'ISO',
  },
  FocalLengthIn35mmFilm: {
    format: (value: number) => (String(value).endsWith('mm') ? value : `${value} mm`),
    label: 'Focal Length',
  },
  LensModel: {
    format: (value: number) => String(value).replace(/"/g, ''),
    label: 'Lens',
  },
};

export default function MetadataPanel() {
  const { t } = useTranslation();
  const [isOrganizationExpanded, setIsOrganizationExpanded] = useState(false);
  const [isAuthorExpanded, setIsAuthorExpanded] = useState(false);
  const [tagInputValue, setTagInputValue] = useState('');
  const [isTagInputFocused, setIsTagInputFocused] = useState(false);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const multiSelectedPaths = useLibraryStore((s) => s.multiSelectedPaths);
  const imageRatings = useLibraryStore((s) => s.imageRatings);
  const appSettings = useSettingsStore((s) => s.appSettings);
  const thumbnails = useProcessStore((s) => s.thumbnails);

  const { handleRate, handleSetColorLabel, handleTagsChanged, handleUpdateExif } = useLibraryActions();

  const rating = selectedImage ? imageRatings[selectedImage.path] || 0 : 0;
  const tags = useLibraryStore((state) => {
    if (!selectedImage) return EMPTY_TAGS;
    return state.imageList.find((img) => img.path === selectedImage.path)?.tags ?? EMPTY_TAGS;
  });
  const liveThumbnailUrl = selectedImage ? thumbnails[selectedImage.path] : undefined;

  const targetPaths = multiSelectedPaths?.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : [];
  const getPathsToUpdate = () => {
    const { imageList } = useLibraryStore.getState();
    const groupingMode = useSettingsStore.getState().appSettings?.grouping ?? 'off';
    return expandGroupedPaths(imageList, targetPaths, groupingMode);
  };

  const { cameraGridSettings, lensSetting, gpsData, otherExifEntries } = useMemo(() => {
    const exif = selectedImage?.exif || {};

    const cameraGridKeys = ['ExposureTime', 'FNumber', 'PhotographicSensitivity', 'FocalLengthIn35mmFilm'];
    const cameraGridSettings = cameraGridKeys.map((key) => {
      const value = exif[key];
      const hasValue = value !== undefined && value !== null && value !== '';

      const translatedLabel =
        key === 'FNumber'
          ? t('editor.metadata.camera.aperture')
          : key === 'ExposureTime'
            ? t('editor.metadata.camera.shutterSpeed')
            : key === 'PhotographicSensitivity'
              ? t('editor.metadata.camera.iso')
              : key === 'FocalLengthIn35mmFilm'
                ? t('editor.metadata.camera.focalLength')
                : '';

      return {
        key: key,
        label: translatedLabel,
        value:
          hasValue && KEY_CAMERA_SETTINGS_MAP[key].format
            ? KEY_CAMERA_SETTINGS_MAP[key].format!(value as number)
            : hasValue
              ? value
              : '-',
      };
    });

    const lensValue = exif['LensModel'];
    const hasLensValue = lensValue !== undefined && lensValue !== null && lensValue !== '';
    const lensSetting = {
      key: 'LensModel',
      label: t('editor.metadata.camera.lens'),
      value:
        hasLensValue && KEY_CAMERA_SETTINGS_MAP['LensModel'].format
          ? KEY_CAMERA_SETTINGS_MAP['LensModel'].format(lensValue as number)
          : hasLensValue
            ? lensValue
            : '-',
    };

    const latStr = exif.GPSLatitude;
    const latRef = exif.GPSLatitudeRef;
    const lonStr = exif.GPSLongitude;
    const lonRef = exif.GPSLongitudeRef;

    const gpsData: GPSData = { lat: null, lon: null, altitude: exif.GPSAltitude || null };
    if (latStr && latRef && lonStr && lonRef) {
      const parsedLat = parseDms(latStr);
      const parsedLon = parseDms(lonStr);
      if (parsedLat !== null && parsedLon !== null) {
        gpsData.lat = latRef.toUpperCase() === 'S' ? -parsedLat : parsedLat;
        gpsData.lon = lonRef.toUpperCase() === 'W' ? -parsedLon : parsedLon;
      }
    }

    const handledKeys = [...cameraGridKeys, 'LensModel', ...EDITABLE_FIELDS.map((f) => f.key)];
    const otherExifEntries = Object.entries(exif)
      .filter(([key]) => !handledKeys.includes(key))
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    return { cameraGridSettings, lensSetting, gpsData, otherExifEntries };
  }, [selectedImage?.exif, t]);

  const currentColor = useMemo(() => {
    return tags.find((tag: string) => tag.startsWith('color:'))?.substring(6) || null;
  }, [tags]);

  const currentTags = useMemo(() => {
    return tags
      .filter((t) => !t.startsWith('color:'))
      .map((t) => ({
        tag: t.startsWith(USER_TAG_PREFIX) ? t.substring(USER_TAG_PREFIX.length) : t,
        isUser: t.startsWith(USER_TAG_PREFIX),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [tags]);

  const hasGps = gpsData.lat !== null && gpsData.lon !== null;
  const fullPath = selectedImage?.path || '';
  const isVirtualCopy = fullPath.includes('?vc=');
  const basePath = fullPath.split('?vc=')[0];
  const fileName = basePath.split(/[\\/]/).pop() || '';
  const fileExtension = fileName.split('.').pop()?.toUpperCase() || 'FILE';
  const megapixels =
    selectedImage?.width && selectedImage?.height
      ? ((selectedImage.width * selectedImage.height) / 1000000).toFixed(1)
      : null;

  const handleAddTag = async (tagToAdd: string) => {
    const newTagValue = tagToAdd.trim().toLowerCase();
    if (newTagValue && !currentTags.some((t) => t.tag === newTagValue)) {
      try {
        const prefixedTag = `${USER_TAG_PREFIX}${newTagValue}`;
        const pathsToUpdate = getPathsToUpdate();
        await invoke(Invokes.AddTagForPaths, { paths: pathsToUpdate, tag: prefixedTag });

        const newTags = [...currentTags, { tag: newTagValue, isUser: true }];
        handleTagsChanged(targetPaths, newTags);
        setTagInputValue('');
      } catch (err) {
        toast.error(`添加标签失败: ${err}`);
      }
    }
  };

  const handleRemoveTag = async (tagToRemove: { tag: string; isUser: boolean }) => {
    try {
      const prefixedTag = tagToRemove.isUser ? `${USER_TAG_PREFIX}${tagToRemove.tag}` : tagToRemove.tag;
      const pathsToUpdate = getPathsToUpdate();
      await invoke(Invokes.RemoveTagForPaths, { paths: pathsToUpdate, tag: prefixedTag });

      const newTags = currentTags.filter((t) => t.tag !== tagToRemove.tag);
      handleTagsChanged(targetPaths, newTags);
    } catch (err) {
      toast.error(`移除标签失败: ${err}`);
    }
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag(tagInputValue);
    }
    e.stopPropagation();
  };

  const LensIcon = CAMERA_ICONS['LensModel'];

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.metadata.title')}</Text>
      </div>
      <div className="grow overflow-y-auto p-3 custom-scrollbar">
        {selectedImage ? (
          <div className="flex flex-col gap-6">
            <div>
              <Text variant={TextVariants.heading} className="mb-3">
                {t('editor.metadata.fileInfo.title')}
              </Text>
              <div className="bg-surface border border-surface rounded-xl p-3.5 flex flex-col gap-2 cursor-default relative min-h-[5.5rem] overflow-hidden">
                {(liveThumbnailUrl || selectedImage?.thumbnailUrl) && (
                  <div
                    className="absolute inset-y-0 right-0 w-2/3 pointer-events-none opacity-20"
                    style={{
                      backgroundImage: `url(${liveThumbnailUrl || selectedImage.thumbnailUrl})`,
                      backgroundPosition: 'right center',
                      backgroundSize: 'cover',
                      filter: 'grayscale(100%)',
                      maskImage: 'linear-gradient(to right, transparent 5%, black 80%)',
                      WebkitMaskImage: 'linear-gradient(to right, transparent 5%, black 80%)',
                    }}
                  />
                )}

                <div className="flex justify-between items-start gap-4 relative z-10">
                  <Text weight={TextWeights.semibold} color={TextColors.primary} className="truncate drop-shadow-sm">
                    {fileName || '-'}
                  </Text>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isVirtualCopy && (
                      <div
                        className="bg-bg-primary/80 backdrop-blur-md text-text-secondary font-bold text-[10px] rounded-md px-2 py-1 tracking-wider uppercase shadow-sm border border-surface/50"
                        data-tooltip={t('editor.metadata.fileInfo.virtualCopy')}
                      >
                        VC
                      </div>
                    )}
                    <div className="bg-bg-primary/80 backdrop-blur-md text-text-secondary font-bold text-[10px] rounded-md px-2 py-1 tracking-wider uppercase shadow-sm border border-surface/50">
                      {fileExtension}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-0.5 relative z-10">
                  <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate drop-shadow-sm">
                    {selectedImage.width && selectedImage.height
                      ? t('editor.metadata.fileInfo.dimensions', {
                          width: selectedImage.width,
                          height: selectedImage.height,
                          megapixels,
                        })
                      : t('editor.metadata.fileInfo.emptyDimensions')}
                  </Text>
                  <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate drop-shadow-sm">
                    {selectedImage.exif?.DateTimeOriginal || '-'}
                  </Text>
                </div>
              </div>
            </div>

            <div>
              <Text variant={TextVariants.heading} className="mb-3">
                {t('editor.metadata.camera.title')}
              </Text>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {cameraGridSettings.map((item: any) => {
                    const Icon = CAMERA_ICONS[item.key];
                    return (
                      <div
                        key={item.key}
                        className="flex items-center gap-2 bg-surface border border-surface px-3 py-2 rounded-xl cursor-default"
                        data-tooltip={item.label}
                      >
                        {Icon && (
                          <span className="text-text-secondary opacity-90 flex items-center justify-center shrink-0">
                            <Icon />
                          </span>
                        )}
                        <Text
                          as="span"
                          variant={TextVariants.small}
                          color={TextColors.primary}
                          weight={TextWeights.medium}
                          className="truncate"
                        >
                          {item.value}
                        </Text>
                      </div>
                    );
                  })}
                </div>

                <div
                  className="flex items-center gap-2 bg-surface border border-surface px-3 py-2 rounded-xl cursor-default"
                  data-tooltip={lensSetting.label}
                >
                  {LensIcon && (
                    <span className="text-text-secondary opacity-90 flex items-center justify-center shrink-0">
                      <LensIcon />
                    </span>
                  )}
                  <Text
                    as="span"
                    variant={TextVariants.small}
                    weight={TextWeights.medium}
                    color={TextColors.primary}
                    className="truncate"
                  >
                    {lensSetting.value}
                  </Text>
                </div>
              </div>
            </div>

            <div>
              <Text variant={TextVariants.heading} className="mb-3">
                {t('editor.metadata.author.title')}
              </Text>
              <div className="bg-surface rounded-xl overflow-hidden">
                <button
                  onClick={() => setIsAuthorExpanded(!isAuthorExpanded)}
                  className="w-full flex items-center justify-between p-3 hover:bg-card-active transition-colors"
                >
                  <Text
                    as="span"
                    variant={TextVariants.label}
                    color={TextColors.primary}
                    className="flex items-center gap-2"
                  >
                    <User size={16} /> {t('editor.metadata.author.creatorDetails')}
                  </Text>
                  <Text color={TextColors.secondary}>
                    {isAuthorExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </Text>
                </button>

                <AnimatePresence initial={false}>
                  {isAuthorExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-2 pb-3 pt-2 border-t border-surface/50 flex flex-col gap-0.5">
                        {EDITABLE_FIELDS.map((field) => {
                          const rawValue = (selectedImage?.exif?.[field.key] as string) || '';
                          const cleanValue = rawValue.replace(/^"|"$/g, '').trim();
                          const displayValue = cleanValue.toLowerCase() === 'default' ? '' : cleanValue;
                          return (
                            <EditableMetadataItem
                              key={field.key}
                              label={t(`editor.metadata.fields.${field.label}`)}
                              value={displayValue}
                              onSave={(newVal) => {
                                handleUpdateExif(targetPaths, { [field.key]: newVal });
                              }}
                            />
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div>
              <Text variant={TextVariants.heading} className="mb-3">
                {t('editor.metadata.organization.title')}
              </Text>
              <div className="bg-surface rounded-xl overflow-hidden">
                <button
                  onClick={() => setIsOrganizationExpanded(!isOrganizationExpanded)}
                  className="w-full flex items-center justify-between p-3 hover:bg-card-active transition-colors"
                >
                  <Text
                    as="span"
                    variant={TextVariants.label}
                    color={TextColors.primary}
                    className="flex items-center gap-2"
                  >
                    <Tag size={16} /> {t('editor.metadata.organization.ratingLabels')}
                  </Text>
                  <Text color={TextColors.secondary}>
                    {isOrganizationExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </Text>
                </button>

                <AnimatePresence initial={false}>
                  {isOrganizationExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 pt-2 border-t border-surface/50 flex flex-col gap-4">
                        <div>
                          <Text
                            variant={TextVariants.small}
                            color={TextColors.primary}
                            weight={TextWeights.semibold}
                            className="uppercase tracking-wider mb-2 block"
                          >
                            {t('editor.metadata.organization.rating')}
                          </Text>
                          <div className="flex items-center gap-2">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <button
                                key={star}
                                onClick={() => handleRate(star, targetPaths)}
                                className="focus:outline-hidden transition-transform active:scale-95 hover:scale-110"
                              >
                                <Star
                                  size={20}
                                  className={clsx(
                                    'transition-colors duration-200',
                                    star <= rating
                                      ? 'fill-accent text-accent'
                                      : 'fill-transparent text-text-secondary hover:text-text-primary',
                                  )}
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <Text
                            variant={TextVariants.small}
                            color={TextColors.primary}
                            weight={TextWeights.semibold}
                            className="uppercase tracking-wider mb-2 block"
                          >
                            {t('editor.metadata.organization.colorLabel')}
                          </Text>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => handleSetColorLabel(null, targetPaths)}
                              className={clsx(
                                'w-5 h-5 rounded-full flex items-center justify-center transition-all hover:scale-110',
                                currentColor === null
                                  ? 'ring-2 ring-text-secondary ring-offset-1 ring-offset-bg-primary'
                                  : 'opacity-50 hover:opacity-100 hover:ring-2 hover:ring-text-secondary/20',
                              )}
                              data-tooltip={t('editor.metadata.organization.none')}
                            >
                              <X size={12} className="text-text-tertiary" />
                            </button>
                            {COLOR_LABELS.map((color: Color) => (
                              <button
                                key={color.name}
                                onClick={() => handleSetColorLabel(color.name, targetPaths)}
                                className={clsx(
                                  'w-5 h-5 rounded-full transition-all hover:scale-110',
                                  currentColor === color.name
                                    ? 'ring-2 ring-white ring-offset-1 ring-offset-bg-primary'
                                    : 'hover:ring-2 hover:ring-white/20',
                                )}
                                style={{ backgroundColor: color.color }}
                                data-tooltip={`${t('library.labels.color' + color.name.charAt(0).toUpperCase() + color.name.slice(1))}${COLOR_LABEL_SHORTCUT[color.name] ? ` (${COLOR_LABEL_SHORTCUT[color.name]})` : ''}`}
                              >
                                {currentColor === color.name && <Check size={12} className="text-black/50 mx-auto" />}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <Text
                            variant={TextVariants.small}
                            color={TextColors.primary}
                            weight={TextWeights.semibold}
                            className="uppercase tracking-wider mb-2 block"
                          >
                            {t('editor.metadata.organization.tags')}
                          </Text>
                          <div className="flex flex-wrap gap-1 mb-2">
                            <AnimatePresence>
                              {currentTags.length > 0 ? (
                                currentTags.map((tagItem) => (
                                  <motion.div
                                    key={tagItem.tag}
                                    layout
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.8 }}
                                    className="flex items-center gap-1 bg-bg-primary px-2 py-1 rounded-md group cursor-pointer border border-surface hover:border-text-tertiary/50 transition-colors"
                                    onClick={() => handleRemoveTag(tagItem)}
                                  >
                                    <Text
                                      as="span"
                                      variant={TextVariants.small}
                                      color={TextColors.primary}
                                      weight={TextWeights.medium}
                                    >
                                      {tagItem.tag}
                                    </Text>
                                    <X size={10} className="opacity-50 group-hover:opacity-100" />
                                  </motion.div>
                                ))
                              ) : (
                                <Text variant={TextVariants.small} className="italic text-text-secondary">
                                  {t('editor.metadata.organization.noTags')}
                                </Text>
                              )}
                            </AnimatePresence>
                          </div>

                          <div
                            className={clsx(
                              'flex items-center bg-bg-primary border rounded-md px-2 py-1.5 transition-colors',
                              isTagInputFocused ? 'border-accent' : 'border-surface',
                            )}
                          >
                            <input
                              type="text"
                              value={tagInputValue}
                              onChange={(e) => setTagInputValue(e.target.value)}
                              onKeyDown={handleTagInputKeyDown}
                              onFocus={() => setIsTagInputFocused(true)}
                              onBlur={() => setIsTagInputFocused(false)}
                              placeholder={t('editor.metadata.organization.addTagPlaceholder')}
                              className="bg-transparent border-none outline-hidden text-xs w-full text-text-primary placeholder-text-tertiary"
                            />
                            <button
                              onClick={() => handleAddTag(tagInputValue)}
                              disabled={!tagInputValue.trim()}
                              className="text-text-secondary hover:text-accent disabled:opacity-30 transition-colors"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                          {appSettings?.taggingShortcuts && appSettings.taggingShortcuts.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {appSettings.taggingShortcuts.map((shortcut) => (
                                <button
                                  key={shortcut}
                                  onClick={() => handleAddTag(shortcut)}
                                  className="text-xs font-medium bg-bg-secondary hover:bg-card-active text-text-secondary px-1.5 py-0.5 rounded-sm border border-transparent hover:border-border-color transition-all"
                                >
                                  {shortcut}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {hasGps && gpsData?.lat && gpsData?.lon && (
              <div>
                <Text variant={TextVariants.heading} className="mb-3">
                  {t('editor.metadata.gps.title')}
                </Text>
                <div className="bg-surface border border-surface rounded-xl p-3 flex flex-col gap-3">
                  <div className="relative rounded-md overflow-hidden shadow-sm bg-bg-secondary">
                    {/* 纯离线 SVG 世界地图缩略图，红点标记拍摄位置 */}
                    <svg
                      viewBox="0 0 360 180"
                      className="w-full h-[180px]"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-label={t('editor.metadata.gps.offlineMapLabel')}
                    >
                      {/* 海洋背景 */}
                      <rect width="360" height="180" fill="var(--surface, #2a2a2a)" />
                      {/* 简化大陆轮廓线（多段 path，不依赖外部资源） */}
                      <g
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity="0.25"
                        strokeWidth="0.7"
                        className="text-text-secondary"
                      >
                        {/* 北美 */}
                        <path d="M45,40 L80,35 L95,45 L100,65 L90,75 L75,80 L60,75 L45,60 Z" />
                        {/* 南美 */}
                        <path d="M115,90 L130,95 L140,120 L135,150 L120,160 L110,140 L108,110 Z" />
                        {/* 欧洲 */}
                        <path d="M170,40 L200,38 L215,50 L210,65 L190,70 L175,65 L168,55 Z" />
                        {/* 非洲 */}
                        <path d="M185,75 L215,72 L225,100 L220,135 L200,150 L185,135 L180,105 Z" />
                        {/* 亚洲 */}
                        <path d="M215,40 L270,35 L300,45 L310,65 L300,80 L270,85 L245,80 L225,70 L218,55 Z" />
                        {/* 澳洲 */}
                        <path d="M290,130 L315,128 L325,140 L318,152 L300,155 L288,145 Z" />
                      </g>
                      {/* 赤道 + 经纬辅助线 */}
                      <line
                        x1="0"
                        y1="90"
                        x2="360"
                        y2="90"
                        stroke="currentColor"
                        strokeOpacity="0.08"
                        strokeWidth="0.4"
                      />
                      <line
                        x1="180"
                        y1="0"
                        x2="180"
                        y2="180"
                        stroke="currentColor"
                        strokeOpacity="0.08"
                        strokeWidth="0.4"
                      />
                      {/* 拍摄位置红点 */}
                      {(() => {
                        // 经纬度 → SVG 坐标：lon [-180,180]→x[0,360], lat [90,-90]→y[0,180]
                        const x = ((gpsData.lon! + 180) / 360) * 360;
                        const y = ((90 - gpsData.lat!) / 180) * 180;
                        return (
                          <g>
                            <circle cx={x} cy={y} r="6" fill="currentColor" className="text-accent" opacity="0.3" />
                            <circle cx={x} cy={y} r="3" fill="currentColor" className="text-accent" />
                            <circle cx={x} cy={y} r="1.2" fill="white" />
                          </g>
                        );
                      })()}
                    </svg>
                    {/* 打开在线地图入口（显式动作，需用户点击才联网） */}
                    <a
                      className="absolute bottom-1 right-1 bg-bg-primary/80 backdrop-blur-sm text-text-secondary text-[10px] rounded-md px-2 py-1 border border-surface/50 hover:text-accent transition-colors cursor-pointer flex items-center gap-1"
                      href={`https://www.openstreetmap.org/?mlat=${gpsData.lat}&mlon=${gpsData.lon}#map=15/${gpsData.lat}/${gpsData.lon}`}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {t('editor.metadata.gps.openOnlineMap')} ↗
                    </a>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <MetadataItem label={t('editor.metadata.gps.latitude')} value={gpsData.lat?.toFixed(6)} />
                    <MetadataItem label={t('editor.metadata.gps.longitude')} value={gpsData.lon?.toFixed(6)} />
                    {gpsData.altitude && (
                      <MetadataItem label={t('editor.metadata.gps.altitude')} value={`${gpsData.altitude} m`} />
                    )}
                  </div>
                </div>
              </div>
            )}

            {otherExifEntries.length > 0 && (
              <div>
                <Text variant={TextVariants.heading} className="mb-3">
                  {t('editor.metadata.extendedExif.title')}
                </Text>
                <div className="bg-surface border border-surface rounded-xl p-3 flex flex-col gap-0.5 overflow-hidden">
                  {otherExifEntries.map(([tag, value]) => (
                    <MetadataItem key={tag} label={formatExifTag(tag)} value={value} />
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center"
            >
              {t('editor.ai.noImageSelected')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
