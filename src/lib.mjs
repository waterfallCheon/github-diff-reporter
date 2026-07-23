import { execFileSync } from "node:child_process";

export const ZERO_SHA = "0".repeat(40);

export function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  }).trim();
}

export function commitsForPush(event, gitRunner = git) {
  if (event.deleted || !event.ref?.startsWith("refs/heads/")) return [];

  const before = event.before;
  const after = event.after;
  if (!after || after === ZERO_SHA) return [];

  if (before && before !== ZERO_SHA) {
    try {
      const output = gitRunner(["rev-list", "--reverse", `${before}..${after}`]);
      if (output) return output.split(/\r?\n/).filter(Boolean);
    } catch {
      // Force pushes and shallow histories can make the range unavailable.
    }
  }

  return (event.commits ?? []).map((commit) => commit.id).filter(Boolean);
}

const SECRET_PATTERNS = [
  [/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]", "GitHub 토큰"],
  [/\bgsk_[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GROQ_API_KEY]", "Groq API 키"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED_API_KEY]", "API 키"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]", "AWS Access Key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]", "Slack 토큰"],
  [/(Authorization\s*[:=]\s*(?:Bearer\s+)?)[^\s"']{8,}/gi, "$1[REDACTED]", "Authorization 값"],
  [/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'`])([^"'`\r\n]{8,})(["'`])/gi, "$1[REDACTED]$3", "비밀값 리터럴"],
  [/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)([A-Za-z0-9_+/=-]{16,})/gi, "$1[REDACTED]", "비밀값 할당"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi, "[REDACTED_CREDENTIAL_URL]", "인증정보 포함 URL"],
  [/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]", "개인키"],
];

const SENSITIVE_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i,
  /(^|\/)(?:\.npmrc|\.pypirc|\.netrc)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)$/i,
];

export function splitPatterns(value = "") {
  return String(value).split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
}

export function globToRegex(pattern) {
  const normalized = String(pattern).replaceAll("\\", "/");
  const doubleStar = "\u0000";
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", doubleStar)
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function isSensitivePath(filePath, additionalPatterns = []) {
  const normalized = String(filePath).replaceAll("\\", "/");
  return SENSITIVE_PATHS.some((pattern) => pattern.test(normalized))
    || additionalPatterns.some((pattern) => globToRegex(pattern).test(normalized));
}

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    String(text ?? ""),
  );
}

export function secretFindings(text) {
  const value = String(text ?? "");
  return SECRET_PATTERNS
    .filter(([pattern]) => {
      pattern.lastIndex = 0;
      const found = pattern.test(value);
      pattern.lastIndex = 0;
      return found;
    })
    .map(([, , label]) => label);
}

export function prepareAiDiff(diff, maxCharacters = 14000) {
  const findings = secretFindings(diff);
  if (findings.length) return { blocked: true, findings, content: "", truncated: false };

  const redacted = redactSecrets(diff);
  if (redacted.length <= maxCharacters) {
    return { blocked: false, findings: [], content: redacted, truncated: false };
  }
  return {
    blocked: false,
    findings: [],
    content: `${redacted.slice(0, maxCharacters)}\n\n[DIFF_TRUNCATED]`,
    truncated: true,
  };
}

export function parseModelJson(content) {
  const unfenced = String(content ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(unfenced);
}

const REPORT_ARRAY_FIELDS = [
  "purpose", "before", "after", "keyChanges", "executionFlow", "fileGuide",
  "technicalDecisions", "alternatives", "risks", "testGuide",
  "comprehensionQuestions", "comprehensionAnswers", "cognitiveDebt", "nextSteps",
];

function normalizedItems(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((item) => typeof item === "string" ? item : JSON.stringify(item))
    .map((item) => item.trim().slice(0, 1800))
    .filter(Boolean)
    .slice(0, 20);
}

export function normalizeAiReport(value, meta) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 응답이 JSON 객체가 아닙니다.");
  }

  const report = {
    title: String(value.title || compactTitle(meta.message, meta.sha)).trim().slice(0, 70),
    changeType: String(value.changeType || "복합 변경").trim().slice(0, 50),
    summary: String(value.summary || "AI가 변경 내용을 분석했습니다.").trim().slice(0, 1800),
  };
  for (const field of REPORT_ARRAY_FIELDS) report[field] = normalizedItems(value[field]);
  if (!report.purpose.length) report.purpose = [meta.message || "커밋 메시지가 없습니다."];
  return report;
}

export function koreanDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const CATEGORY_RULES = [
  ["테스트", /(^|\/)(?:test|tests|__tests__|spec)(\/|$)|\.(?:test|spec)\.[^/]+$/i],
  ["문서", /(^|\/)(?:docs?|documentation)(\/|$)|\.(?:md|mdx|rst|txt)$/i],
  ["CI/CD", /(^|\/)\.github\/workflows\/|(^|\/)(?:Dockerfile|docker-compose[^/]*|Jenkinsfile)$/i],
  ["의존성", /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|poetry\.lock|Cargo\.lock|go\.(?:mod|sum)|composer\.lock)$/i],
  ["데이터베이스", /(^|\/)(?:migrations?|schema|database|db)(\/|$)|\.(?:sql|prisma)$/i],
  ["설정", /(^|\/)(?:config|configs)(\/|$)|\.(?:ya?ml|toml|ini|properties|config)$/i],
  ["프론트엔드", /(^|\/)(?:components?|pages?|views?|styles?|frontend|web)(\/|$)|\.(?:css|scss|sass|less|vue|svelte)$/i],
  ["백엔드", /(^|\/)(?:api|server|backend|controllers?|services?|routes?)(\/|$)/i],
  ["정적 자산", /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i],
];

export function classifyFile(filePath) {
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(filePath))?.[0] || "소스/기타";
}

function formatStat(file) {
  if (file.binary) return "바이너리 변경";
  return `+${file.additions} / -${file.deletions}`;
}

function inferChangeType(message, categories) {
  const prefix = String(message).match(/^([a-z]+)(?:\([^)]*\))?!?:/i)?.[1]?.toLowerCase();
  const byPrefix = {
    feat: "기능", fix: "버그 수정", refactor: "리팩터링", test: "테스트",
    docs: "문서", chore: "유지보수", build: "빌드", ci: "CI/CD", perf: "성능",
  };
  if (prefix && byPrefix[prefix]) return byPrefix[prefix];
  if (categories.length === 1) return categories[0];
  return "복합 변경";
}

function compactTitle(message, sha) {
  const firstLine = String(message || "").split(/\r?\n/)[0].trim();
  return (firstLine || `커밋 ${sha.slice(0, 7)}`).slice(0, 70);
}

export function createLocalReport(meta, options = {}) {
  const includeFilePaths = options.includeFilePaths !== false;
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(0, options.maxFiles) : 30;
  const groups = new Map();

  for (const file of meta.fileDetails) {
    const category = classifyFile(file.path);
    const current = groups.get(category) || { count: 0, additions: 0, deletions: 0 };
    current.count += 1;
    current.additions += file.additions;
    current.deletions += file.deletions;
    groups.set(category, current);
  }

  const categories = [...groups.keys()];
  const keyChanges = [...groups.entries()].map(([category, stats]) =>
    `${category}: ${stats.count}개 파일 · +${stats.additions} / -${stats.deletions}`,
  );
  if (meta.excludedFileCount) {
    keyChanges.push(`민감 경로: ${meta.excludedFileCount}개 파일명과 변경량을 보고서에서 제외`);
  }

  const fileGuide = includeFilePaths
    ? meta.fileDetails.slice(0, maxFiles).map((file) =>
      `${file.path} · ${classifyFile(file.path)} · ${formatStat(file)}`,
    )
    : [];
  if (includeFilePaths && meta.fileDetails.length > maxFiles) {
    fileGuide.push(`그 외 ${meta.fileDetails.length - maxFiles}개 파일은 목록에서 생략`);
  }

  const risks = [];
  const hasCode = categories.some((category) => ["소스/기타", "프론트엔드", "백엔드", "데이터베이스"].includes(category));
  if (hasCode && !groups.has("테스트")) risks.push("코드 변경과 함께 수정된 테스트 파일이 확인되지 않습니다.");
  if (groups.has("설정") || groups.has("CI/CD")) risks.push("환경별 설정값과 배포 워크플로 동작을 확인해야 합니다.");
  if (groups.has("데이터베이스")) risks.push("스키마 호환성, 마이그레이션 순서와 롤백 방법을 확인해야 합니다.");
  if (groups.has("의존성")) risks.push("의존성 잠금 파일과 보안·호환성 영향을 확인해야 합니다.");
  if (meta.additions + meta.deletions >= 500) risks.push("변경량이 크므로 파일 영역별로 나누어 검토하는 것이 좋습니다.");
  if (!risks.length) risks.push("파일 종류와 변경량만으로 특별한 위험 신호는 발견되지 않았습니다.");

  const testGuide = [];
  if (groups.has("테스트")) testGuide.push("변경된 테스트를 실행하고 기존 테스트의 회귀 여부를 확인합니다.");
  if (hasCode) testGuide.push("변경된 기능의 정상 흐름과 실패 흐름을 각각 직접 확인합니다.");
  if (groups.has("설정") || groups.has("CI/CD")) testGuide.push("테스트 환경에서 빌드와 배포 워크플로를 한 번 실행합니다.");
  if (groups.has("문서") && !hasCode) testGuide.push("문서 링크, 코드 예제와 렌더링 결과를 확인합니다.");

  return {
    title: compactTitle(meta.message, meta.sha),
    changeType: inferChangeType(meta.message, categories),
    summary: `${meta.fileDetails.length}개 공개 가능한 파일에서 +${meta.additions} / -${meta.deletions}줄이 변경되었습니다. ${categories.length ? `주요 영역은 ${categories.join(", ")}입니다.` : "공개 가능한 파일 메타데이터가 없습니다."}`,
    purpose: [meta.message || "커밋 메시지가 없습니다."],
    keyChanges,
    fileGuide,
    risks,
    testGuide,
    cognitiveDebt: [
      "이 보고서는 외부 AI 없이 파일 경로와 변경량만으로 작성되어 함수의 실제 동작 변화나 개발 의도를 판단하지 않습니다.",
    ],
    nextSteps: [
      "의미 있는 동작 변화는 커밋 메시지 또는 Notion 본문에 사람이 한 줄 보완하면 가장 정확합니다.",
    ],
    generationNotice: options.fallbackReason
      ? `Groq 미사용 · ${options.fallbackReason} · 파일 메타데이터 기반 로컬 보고서`
      : "외부 AI 미사용 · 원문 Diff 미전송 · GitHub Actions 내부의 파일 메타데이터 기반 자동 보고서",
  };
}

export function richText(content, options = {}) {
  if (!content) return [];
  return [{
    type: "text",
    text: { content: String(content).slice(0, 2000), ...(options.url ? { link: { url: options.url } } : {}) },
    annotations: {
      bold: Boolean(options.bold),
      italic: false,
      strikethrough: false,
      underline: false,
      code: Boolean(options.code),
      color: "default",
    },
  }];
}

function paragraph(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function heading(text, level = 2) {
  const type = `heading_${level}`;
  return { object: "block", type, [type]: { rich_text: richText(text) } };
}

function bullets(items) {
  return (items ?? []).filter(Boolean).slice(0, 40).map((item) => ({
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(typeof item === "string" ? item : JSON.stringify(item)) },
  }));
}

export function reportToBlocks(report, meta) {
  const blocks = [
    { object: "block", type: "callout", callout: { icon: { type: "emoji", emoji: "📝" }, rich_text: richText(report.summary || meta.message) } },
    { object: "block", type: "callout", callout: { icon: { type: "emoji", emoji: "🔒" }, rich_text: richText(report.generationNotice) } },
  ];

  const sections = [
    ["변경 목적", report.purpose],
    ["변경 전 동작", report.before],
    ["변경 후 동작", report.after],
    ["주요 변경 영역", report.keyChanges],
    ["실행 흐름", report.executionFlow],
    ["파일별 변경", report.fileGuide],
    ["기술적 선택과 이유", report.technicalDecisions],
    ["고려할 수 있는 대안", report.alternatives],
    ["검토 포인트", report.risks],
    ["확인 방법", report.testGuide],
    ["보고서의 한계", report.cognitiveDebt],
    ["다음 작업", report.nextSteps],
  ];

  for (const [title, value] of sections) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    if (!items.length) continue;
    blocks.push(heading(title), ...bullets(items));
  }

  const questions = report.comprehensionQuestions ?? [];
  const answers = report.comprehensionAnswers ?? [];
  if (questions.length) {
    blocks.push(heading("이해도 확인 질문"));
    questions.slice(0, 8).forEach((question, index) => {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText(question) },
      });
      if (answers[index]) blocks.push(paragraph(`답: ${answers[index]}`));
    });
  }

  blocks.push(
    heading("변경 정보"),
    ...bullets([
      `프로젝트: ${meta.repository}`,
      `브랜치: ${meta.branch}`,
      `Commit: ${meta.sha}`,
      `작성자: ${meta.author}`,
      `보고서 포함 파일: ${meta.fileDetails.length}개`,
      `민감 경로 제외 파일: ${meta.excludedFileCount}개`,
      `추가 ${meta.additions}줄 / 삭제 ${meta.deletions}줄`,
      `원본 커밋: ${meta.commitUrl}`,
    ]),
  );

  return blocks.slice(0, 100);
}
