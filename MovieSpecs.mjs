const audioQuality = {
  DTSX: 18,
  DTSMA: 17,
  'DTS-ES': 16,
  DTSHR: 15,
  TrueHD_Atmos: 14,
  DTS: 13,
  TrueHD: 12,
  EAC3: 11,
  AC3: 10,
  FLAC: 9,
  AAC: 8,
  MP3: 7,
  MP2: 6,
  MP1: 5,
  WMA: 4,
  LPCM: 3,
  PCM: 2,
  ALAW: 1,
  OGG: 0,
};

function translateSize(w, h) {
  let size = 'SD';
  if (h >= 680 || w >= 1200) size = '720p'; // 720  but 680  also good & 1280 but 1200 also good
  if (h > 720 && w > 1280) size = '1080p';
  if (h >= 1080 || w >= 1920) size = '1080p';
  if (h >= 2160 || w >= 3830) size = '4K'; // 3840 but sometimes less 3832 e.g.

  return size;
}

const CODEC_MAP = new Map([
  // AAC
  ['A_AAC', 'AAC'],
  ['A_AAC-2', 'AAC'],
  ['mp4a', 'AAC'],
  ['MPEG-2 AAC Audio', 'AAC'],
  ['mp4a-40-2', 'AAC'],
  ['mp4a-40-29', 'AAC'],
  ['15-2', 'AAC'],
  ['FF-2', 'AAC'],
  ['A_AAC/MPEG2/LC/SBR', 'AAC'],
  ['A_AAC-5', 'AAC'],
  // AC3
  ['A_AC3', 'AC3'],
  ['AC-3', 'AC3'],
  ['ac-3', 'AC3'],
  ['FAST Multimedia DVM', 'AC3'],
  ['Extensible', 'AC3'],
  ['2000', 'AC3'],
  ['92', 'AC3'],
  ['6', 'AC3'],
  ['129', 'AC3'],
  // EAC3
  ['A_EAC3', 'EAC3'],
  ['132', 'EAC3'],
  ['ec-3', 'EAC3'],
  // DTS variants
  ['DTS-ES', 'DTS-ES'],
  ['DTS Master Audio', 'DTSMA'],
  ['DTS Hi-Res', 'DTSHR'],
  // FLAC
  ['A_FLAC', 'FLAC'],
  // MP
  ['Microsoft MPEG', 'MP1'],
  ['MPEG Audio', 'MP1'],
  ['50', 'MP1'],
  ['A_MPEG/L2', 'MP2'],
  ['4', 'MP2'],
  ['A_MPEG/L3', 'MP3'],
  ['MP3', 'MP3'],
  ['55', 'MP3'],
  ['mp4a-6B', 'MP3'],
  // DTS
  ['A_DTS', { XLL: 'DTSMA', 'XLL X': 'DTSX', XBR: 'DTSHR', ES: 'DTS-ES', default: 'DTS' }],
  ['DTS', { XLL: 'DTSMA', 'XLL X': 'DTSX', XBR: 'DTSHR', ES: 'DTS-ES', default: 'DTS' }],
  ['2001', { XLL: 'DTSMA', 'XLL X': 'DTSX', XBR: 'DTSHR', ES: 'DTS-ES', default: 'DTS' }],
  // TrueHD
  ['A_TRUEHD', { '16-ch': 'TrueHD_Atmos', default: 'TrueHD' }],
  ['131', { '16-ch': 'TrueHD_Atmos', default: 'TrueHD' }],
  // WMA
  ['Windows Media Audio V2 V7 V8 V9 / DivX audio (WMA) / Alex AC3 Audio', 'WMA'],
  ['Windows Media Audio Professional V9', 'WMA'],
  ['00002000-0000-0010-8000-00AA00389B71', 'WMA'],
  ['161', 'WMA'],
  // Misc
  ['162', 'RAW'],
  ['A_PCM/INT/LIT', 'LPCM'],
  ['Microsoft PCM', 'PCM'],
  ['sowt', 'PCM'],
  ['1', 'PCM'],
  ['Microsoft a-Law', 'ALAW'],
  ['A_VORBIS', 'OGG'],
  ['A_OPUS', 'OPUS'],
]);

function translateCodec(c, feat) {
  if (c === undefined) return '?';
  const entry = CODEC_MAP.get(c);
  if (entry === undefined) return `unknown codec : '${c}'`;
  if (typeof entry === 'string') return entry;
  return entry[feat] ?? entry.default ?? `unknown codec : '${c}'`;
}

const CHANNEL_MAP = new Map([
  ['1', '1.0'],
  ['1.0', '1.0'],
  ['2', '2.0'],
  ['2.0', '2.0'],
  ['3', '2.1'],
  ['3.0', '2.1'],
  ['4', '4.0'],
  ['5', '5.0'],
  ['5.0', '5.0'],
  ['5.1', '5.1'],
  ['6', '5.1'],
  ['7', '6.1'],
  ['7.1', '7.1'],
  ['8', '7.1'],
]);

function translateChannels(c) {
  if (c === undefined) return '1.0';

  const result = CHANNEL_MAP.get(`${c}`);
  if (!result) {
    console.error(`number of channel unknown : '${c}'`);
    return '0';
  }
  return result;
}

export class MovieSpecs {
  #audio_specs;

  #video_specs;

  constructor() {
    this.#audio_specs = [];
    this.#video_specs = '';
  }

  // static #bestCodecByLang(asbyl) {
  //   if (asbyl.length === 0) return undefined;
  //   const [bc, ...rest] = asbyl;
  //   for (const as of rest) {
  //     if (as.channels > bc.channels) return as;
  //     if (as.channels === bc.channels) if (audioQuality[as.codec] > audioQuality[bc.codec]) return as;
  //   }
  //   return bc;
  // }

  static #bestCodecByLang(asbyl) {
    if (asbyl.length === 0) return undefined;
    return asbyl.reduce((best, as) => {
      if (as.channels > best.channels) return as;
      if (as.channels === best.channels && audioQuality[as.codec] > audioQuality[best.codec]) return as;
      return best;
    });
  }

  videoSize({ Width, Height, colour_primaries: cp }) {
    this.#video_specs = `${translateSize(Width, Height)}${cp === 'BT.2020' ? ' HDR' : ''}`;
  }

  howManyAudio(filter = Boolean) {
    return this.#audio_specs.filter(filter).length;
  }

  toAudioString() {
    return this.#audio_specs;
  }

  audioFormat(number, language, codec, channels, feat) {
    this.#audio_specs.push({
      number,
      language,
      channels,
      codec: translateCodec(codec, feat),
      codec_channel: `${translateCodec(codec, feat)}_${translateChannels(channels)}`,
    });
  }

  toString() {
    let r = `${this.#video_specs}`;
    if (this.#audio_specs.length === 1) return `${r} ${this.#audio_specs[0].codec_channel}`;

    // only 1 french
    const frenchFormat = this.#audio_specs.filter((as) => as.language === 'fr');
    if (frenchFormat.length > 0) return `${r} ${MovieSpecs.#bestCodecByLang(frenchFormat).codec_channel}`;
    // only 1 eng
    const englishFormat = this.#audio_specs.filter((as) => as.language === 'en');
    if (englishFormat.length > 0) return `${r} ${MovieSpecs.#bestCodecByLang(englishFormat).codec_channel}`;

    // same codec_channel
    const reducing = this.#audio_specs.map((as) => as.codec_channel).filter((item, index, all) => all.indexOf(item) === index);
    if (reducing.length === 1) return `${r} ${reducing[0]}`;

    // mix
    // for (const v of this.#audio_specs) r += `\r\n(${v.language}/${v.codec_channel}`;
    this.#audio_specs.forEach(({ language, codec_channel: cc }) => {
      r += `\r\n(${language}/${cc})`;
    });
    return r;
  }
}
