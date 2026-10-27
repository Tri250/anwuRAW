const fs = require("fs");
const { imageSize: sizeOf } = require("image-size");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, BorderStyle, WidthType, VerticalAlign, TabStopType, Tab,
  LevelFormat, LineRuleType,
} = require("docx");

const FONT = { ascii: "Arial", hAnsi: "Arial", eastAsia: "微软雅黑" };
const NAVY = "123A63";
const ACCENT = "1F5FBF";
const TEXT = "333333";
const GRAY = "5E5E5E";
const LIGHT = "9A9A9A";
const RULE = "C9D6E8";

const CONTENT_W = 10106;
const PHOTO_W = 2260;
const LEFT_W = CONTENT_W - PHOTO_W;

const BODY = 19;        // 9.5pt
const LINE = 262;
const BULLET_AFTER = 42;

// ---------- helpers ----------
function run(text, opts = {}) {
  return new TextRun({ text, font: FONT, size: BODY, color: TEXT, ...opts });
}

function sectionTitle(text) {
  return new Paragraph({
    spacing: { before: 240, after: 115, line: 240, lineRule: LineRuleType.AUTO },
    indent: { left: 160 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 28, color: ACCENT, space: 9 },
      bottom: { style: BorderStyle.SINGLE, size: 8, color: RULE, space: 3 },
    },
    children: [run(text, { bold: true, size: 23, color: NAVY })],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "resume-bullets", level: 0 },
    spacing: { before: 0, after: BULLET_AFTER, line: LINE, lineRule: LineRuleType.AUTO },
    children: [run(text)],
  });
}

function jobHeader(company, role, period) {
  return new Paragraph({
    spacing: { before: 185, after: 48, line: 240, lineRule: LineRuleType.AUTO },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
    children: [
      run(company, { bold: true, size: 22, color: NAVY }),
      run("  ｜  " + role, { size: BODY, color: GRAY }),
      new TextRun({ children: [new Tab()], font: FONT, size: 20 }),
      run(period, { size: 19, color: LIGHT }),
    ],
  });
}

// ---------- header ----------
const photo = fs.readFileSync("unpacked/word/media/image1.png");
const pDims = sizeOf(photo);
const pW = 116;
const pH = Math.round((pDims.height / pDims.width) * pW);

const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

const headerTable = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: [LEFT_W, PHOTO_W],
  borders: {
    top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
    insideHorizontal: noBorder, insideVertical: noBorder,
  },
  rows: [
    new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: LEFT_W, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 240 },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              spacing: { before: 0, after: 80, line: 240, lineRule: LineRuleType.AUTO },
              children: [run("覃日丽", { bold: true, size: 52, color: NAVY })],
            }),
            new Paragraph({
              spacing: { before: 0, after: 110, line: 240, lineRule: LineRuleType.AUTO },
              children: [
                run("求职意向：科大讯飞学习机 · 渠道销售 / 门店销售", {
                  bold: true, size: 22, color: ACCENT,
                }),
              ],
            }),
            new Paragraph({
              spacing: { before: 0, after: 0, line: 264, lineRule: LineRuleType.AUTO },
              children: [
                run("15813387768", { size: 19, color: GRAY }),
                run("    ｜    ", { size: 19, color: LIGHT }),
                run("1048590214@qq.com", { size: 19, color: GRAY }),
                run("    ｜    ", { size: 19, color: LIGHT }),
                run("广州", { size: 19, color: GRAY }),
              ],
            }),
            new Paragraph({
              spacing: { before: 20, after: 0, line: 264, lineRule: LineRuleType.AUTO },
              children: [
                run("33岁", { size: 19, color: GRAY }),
                run("    ｜    ", { size: 19, color: LIGHT }),
                run("大专（函授）", { size: 19, color: GRAY }),
                run("    ｜    ", { size: 19, color: LIGHT }),
                run("10年销售与渠道运营经验", { size: 19, color: GRAY }),
              ],
            }),
          ],
        }),
        new TableCell({
          width: { size: PHOTO_W, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { before: 0, after: 0 },
              children: [
                new ImageRun({
                  type: "png",
                  data: photo,
                  transformation: { width: pW, height: pH },
                  altText: { title: "证件照", description: "覃日丽证件照", name: "photo" },
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ],
});

// ---------- body ----------
const divider = new Paragraph({
  spacing: { before: 90, after: 0, line: 240, lineRule: LineRuleType.AUTO },
  border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: RULE, space: 1 } },
  children: [run("", { size: 2 })],
});

const children = [
  headerTable,
  divider,

  sectionTitle("核心优势"),
  bullet("10年销售与渠道运营经验（含7年3C数码终端一线）：历任OPPO政企销售、中国移动微格助理、直营渠道操盘，熟悉门店接待、产品讲解、成交转化与售后维护全流程。"),
  bullet("门店零售与渠道管理：负责合作网点引入、巡检与政策落地，制定门店运营SOP与业绩考核机制，推动直营门店业务全覆盖，提升单店产出。"),
  bullet("终端培训与带教：搭建直营团队培训体系，累计开展培训72场次，店员业务通过率≥95%，擅长将产品卖点转化为一线可执行的销售话术。"),
  bullet("数据驱动与活动落地：通过销量、库存、渗透率数据分析诊断门店问题并输出改进方案；熟悉终端陈列标准，能高效推动促销活动执行。"),
  bullet("品类适配：数码产品重度使用者（2018年玩机达人、高端机达人大使），产品学习上手快，能将AI学习机的核心功能转译为家长可感知的学习价值，并快速掌握竞品差异。"),

  sectionTitle("工作经历"),
  jobHeader("广州智云通讯有限公司", "直营渠道运营（移动业务）", "2025.08 — 2026.06"),
  bullet("渠道引入：负责广州区域直营渠道移动业务整体引入，对接移动公司完成业务准入、系统对接、政策落地与佣金结算。"),
  bullet("门店覆盖与培训：推动直营门店移动业务全覆盖；搭建团队培训体系，覆盖开卡、套餐、芝麻购、宽带、融合业务实操与合规，累计培训72场次，店员业务通过率≥95%。"),
  bullet("运营机制：制定门店SOP与业绩考核机制，推动业务落地执行，提升移动业务渗透率与单店办理量；统筹日常督导与问题解决，保障流程规范、数据准确、合规可控。"),

  jobHeader("中国移动（广州民企人力资源有限公司）", "微格助理 · 渠道管理", "2023.11 — 2025.07"),
  bullet("渠道引入：负责片区移动合作网点引入与巡检，传达合作网点酬金等政策，定期开展网点拜访并收集产量数据。"),
  bullet("渠道管理：通过渠道走访落实业务培训、信息摸查、营销检查与问题收集，负责指标排产、销售指导与执行跟踪，协助渠道达成销售任务并复盘提升。"),
  bullet("社区营销：负责所辖片区社区场景营销活动的组织与落地，扩大业务触达，促进客户转化。"),

  jobHeader("OPPO", "销售助理 · 政企", "2016.03 — 2023.05"),
  bullet("门店销售：负责运营商门店日常销售，熟悉门店客户接待、产品讲解、成交与售后全流程。"),
  bullet("政企客户：负责集团客户开发与维护，跟进售前、售中、售后需求，持续维护并拓展集团客户关系。"),
  bullet("能力沉淀：7年一线3C数码销售积累，形成较强的产品讲解、客户沟通与异议处理能力。"),

  sectionTitle("教育背景"),
  new Paragraph({
    spacing: { before: 0, after: 0, line: 264, lineRule: LineRuleType.AUTO },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
    children: [
      run("广东工业大学", { bold: true, size: 21, color: NAVY }),
      run("  ｜  大专（函授）", { size: BODY, color: GRAY }),
      new TextRun({ children: [new Tab()], font: FONT, size: 20 }),
      run("2021.03 — 2023.07", { size: 19, color: LIGHT }),
    ],
  }),

  sectionTitle("技能与荣誉"),
  new Paragraph({
    spacing: { before: 0, after: 60, line: LINE, lineRule: LineRuleType.AUTO },
    children: [
      run("办公软件：", { bold: true, color: NAVY }),
      run("熟练使用 Word、Excel、PPT，可独立完成数据统计报表与培训课件制作。"),
    ],
  }),
  new Paragraph({
    spacing: { before: 0, after: 0, line: LINE, lineRule: LineRuleType.AUTO },
    children: [
      run("语言与荣誉：", { bold: true, color: NAVY }),
      run("普通话（熟练）、英语（基础读写）；2018年玩机达人、高端机达人大使。"),
    ],
  }),
];

const doc = new Document({
  creator: "AI Assistant",
  title: "覃日丽 - 简历",
  styles: {
    default: {
      document: {
        run: { font: FONT, size: BODY, color: TEXT },
        paragraph: { spacing: { before: 0, after: 0, line: LINE, lineRule: LineRuleType.AUTO } },
      },
    },
  },
  numbering: {
    config: [
      {
        reference: "resume-bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 320, hanging: 230 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 720, right: 900, bottom: 560, left: 900 },
        },
      },
      children,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => fs.writeFileSync("out.docx", buf));
