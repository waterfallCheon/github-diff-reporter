import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFile,
  commitsForPush,
  createLocalReport,
  isSensitivePath,
  normalizeAiReport,
  parseModelJson,
  prepareAiDiff,
  redactSecrets,
  reportToBlocks,
  secretFindings,
  splitPatterns,
  ZERO_SHA,
} from "../src/lib.mjs";

test("returns commits in repository order", () => {
  const event = { ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) };
  const commits = commitsForPush(event, () => "111\n222");
  assert.deepEqual(commits, ["111", "222"]);
});

test("falls back to payload commits for a new branch", () => {
  const event = {
    ref: "refs/heads/feature",
    before: ZERO_SHA,
    after: "b".repeat(40),
    commits: [{ id: "111" }, { id: "222" }],
  };
  assert.deepEqual(commitsForPush(event), ["111", "222"]);
});

test("ignores tag pushes and deletions", () => {
  assert.deepEqual(commitsForPush({ ref: "refs/tags/v1", after: "a".repeat(40) }), []);
  assert.deepEqual(commitsForPush({ ref: "refs/heads/main", deleted: true, after: ZERO_SHA }), []);
});

test("recognizes built-in and custom sensitive paths", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath("config/.env.production"), true);
  assert.equal(isSensitivePath("certs/private.key"), true);
  assert.equal(isSensitivePath("private/design.md", ["private/**"]), true);
  assert.equal(isSensitivePath("src/index.js", ["private/**"]), false);
});

test("splits custom exclusion patterns", () => {
  assert.deepEqual(splitPatterns("private/**, internal/**\ncustomer/*"), [
    "private/**", "internal/**", "customer/*",
  ]);
});

test("redacts secret-like values in commit messages", () => {
  const output = redactSecrets("fix token=ghp_abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(output.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(output, /REDACTED/);
});

test("blocks AI transmission when a real secret pattern is found", () => {
  const diff = "+const key = 'gsk_abcdefghijklmnopqrstuvwxyz123456';";
  const prepared = prepareAiDiff(diff, 18000);
  assert.equal(prepared.blocked, true);
  assert.deepEqual(prepared.findings, ["Groq API 키"]);
  assert.equal(prepared.content, "");
});

test("does not block ordinary token-related source code", () => {
  const diff = "+const token = await getToken(user);";
  assert.deepEqual(secretFindings(diff), []);
  assert.equal(prepareAiDiff(diff, 18000).blocked, false);
});

test("truncates safe AI input", () => {
  const prepared = prepareAiDiff("a".repeat(2000), 1000);
  assert.equal(prepared.blocked, false);
  assert.equal(prepared.truncated, true);
  assert.match(prepared.content, /DIFF_TRUNCATED/);
});

test("parses and normalizes fenced model JSON", () => {
  const parsed = parseModelJson("```json\n{\"title\":\"로그인 개선\",\"purpose\":\"세션 처리 개선\"}\n```");
  const report = normalizeAiReport(parsed, {
    message: "feat: 로그인 개선",
    sha: "a".repeat(40),
  });
  assert.equal(report.title, "로그인 개선");
  assert.deepEqual(report.purpose, ["세션 처리 개선"]);
  assert.deepEqual(report.risks, []);
});

test("classifies common project files", () => {
  assert.equal(classifyFile("src/components/Button.tsx"), "프론트엔드");
  assert.equal(classifyFile("tests/login.test.js"), "테스트");
  assert.equal(classifyFile("docs/setup.md"), "문서");
});

test("creates a structured report without source diff", () => {
  const report = createLocalReport({
    sha: "a".repeat(40),
    message: "feat: 로그인 화면 추가",
    fileDetails: [
      { path: "src/components/Login.tsx", additions: 30, deletions: 2, binary: false },
      { path: "tests/login.test.js", additions: 20, deletions: 0, binary: false },
    ],
    excludedFileCount: 1,
    additions: 50,
    deletions: 2,
  }, { includeFilePaths: true, maxFiles: 30 });

  assert.equal(report.changeType, "기능");
  assert.match(report.summary, /2개/);
  assert.match(report.generationNotice, /원문 Diff 미전송/);
  assert.equal(report.fileGuide.length, 2);
  assert.ok(report.keyChanges.some((item) => item.includes("민감 경로")));
});

test("can omit every file path from the report", () => {
  const report = createLocalReport({
    sha: "a".repeat(40),
    message: "chore: 설정 정리",
    fileDetails: [{ path: "config/app.yml", additions: 1, deletions: 1, binary: false }],
    excludedFileCount: 0,
    additions: 1,
    deletions: 1,
  }, { includeFilePaths: false, maxFiles: 30 });
  assert.deepEqual(report.fileGuide, []);
});

test("builds a polished explain-diff Notion layout", () => {
  const blocks = reportToBlocks({
    summary: "로그인 흐름을 개선했습니다.",
    generationNotice: "민감 정보 검사 통과",
    purpose: ["로그인 실패 원인을 쉽게 파악"],
    before: ["오류 원인이 표시되지 않음"],
    after: ["사용자에게 오류 원인을 안내"],
    keyChanges: ["오류 처리 분기 추가"],
    executionFlow: ["로그인 요청", "응답 검사", "오류 표시"],
    fileGuide: ["src/login.mjs · 로그인 처리"],
    technicalDecisions: ["기존 오류 타입 재사용"],
    alternatives: ["새 오류 타입 추가"],
    risks: ["서버 메시지 노출 여부 확인"],
    testGuide: ["잘못된 비밀번호로 로그인"],
    cognitiveDebt: ["다른 인증 오류는 추가 확인 필요"],
    comprehensionQuestions: ["오류는 언제 표시되나요?"],
    comprehensionAnswers: ["로그인 응답이 실패일 때 표시됩니다."],
    nextSteps: ["통합 테스트 추가"],
  }, {
    message: "feat: 로그인 개선",
    repository: "owner/project",
    branch: "main",
    sha: "a".repeat(40),
    author: "Developer",
    fileDetails: [{ path: "src/login.mjs" }],
    excludedFileCount: 0,
    additions: 10,
    deletions: 2,
    commitUrl: "https://github.com/owner/project/commit/abc",
  });

  assert.deepEqual(blocks.slice(0, 3).map((block) => block.type), ["callout", "callout", "callout"]);
  assert.ok(blocks.some((block) => block.type === "to_do"));
  assert.ok(blocks.some((block) => block.type === "toggle"
    && block.toggle.rich_text[0].text.content.startsWith("Q1.")));
  assert.equal(blocks.at(-1).type, "toggle");
  assert.equal(blocks.at(-1).toggle.rich_text[0].text.content, "커밋 정보");
});
