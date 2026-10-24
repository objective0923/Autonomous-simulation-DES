import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";
import { createSpacePlan } from "./planning";
import type { Project } from "./types";
import {
  applyDrawingSource,
  confirmSourceCalibration,
  dimensionCandidates,
  inspectDrawingBytes,
  MAX_PDF_PAGES,
  MAX_SOURCE_DATA_URL,
  metersPerPixel,
  referenceDistance,
  renderSize,
  updateSourceCalibration,
  validateSourceFile,
  type DrawingSource,
  type SourcePoint,
} from "./source";
import "./UiSource.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const cmapUrls = import.meta.glob<string>(
  "/node_modules/pdfjs-dist/cmaps/*.bcmap",
  { eager: true, query: "?url", import: "default" },
);
const fontUrls = import.meta.glob<string>(
  "/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
  { eager: true, query: "?url", import: "default" },
);
class LocalCMapReader {
  async fetch({ name }: { name: string }) {
    const url = cmapUrls[`/node_modules/pdfjs-dist/cmaps/${name}.bcmap`];
    if (!url) throw new Error(`지원하지 않는 PDF 문자 맵: ${name}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF 문자 맵을 읽지 못했습니다.");
    return {
      cMapData: new Uint8Array(await response.arrayBuffer()),
      compressionType: 1,
    };
  }
}
class LocalFontReader {
  async fetch({ filename }: { filename: string }) {
    const url = fontUrls[`/node_modules/pdfjs-dist/standard_fonts/${filename}`];
    if (!url) throw new Error(`지원하지 않는 PDF 기본 글꼴: ${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF 기본 글꼴을 읽지 못했습니다.");
    return new Uint8Array(await response.arrayBuffer());
  }
}

const nice = (value: number) =>
  value.toLocaleString("ko-KR", { maximumFractionDigits: 3 });

export default function UiSource({
  project,
  onChange,
  disabled = false,
}: {
  project: Project;
  onChange: (project: Project) => void;
  disabled?: boolean;
}) {
  const projectRef = useRef(project),
    changeRef = useRef(onChange);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  projectRef.current = project;
  changeRef.current = onChange;
  const pdfRef = useRef<PDFDocumentProxy | null>(null),
    loadingRef = useRef<PDFDocumentLoadingTask | null>(null),
    renderRef = useRef<RenderTask | null>(null);
  const generation = useRef(0),
    pdfName = useRef("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [page, setPage] = useState(1),
    [pageInput, setPageInput] = useState("1"),
    [pageCount, setPageCount] = useState(0);
  const [candidates, setCandidates] = useState<string[]>([]),
    [points, setPoints] = useState<SourcePoint[]>([]),
    [picking, setPicking] = useState(false);
  const plan = project.spacePlan ?? createSpacePlan(),
    source = plan.source;
  const cal = plan.calibration;
  let scale: number | null = null;
  try {
    scale = metersPerPixel(cal.referencePixels, cal.referenceMeters);
  } catch {
    /* An uncalibrated source is an explicit draft. */
  }

  useEffect(
    () => () => {
      generation.current++;
      renderRef.current?.cancel();
      void loadingRef.current?.destroy().catch(() => {});
      void pdfRef.current?.destroy().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    setPoints(cal.points ? [...cal.points] : []);
    setPicking(false);
  }, [source?.dataUrl, JSON.stringify(cal.points)]);
  useEffect(() => {
    if (disabled) {
      generation.current++;
      renderRef.current?.cancel();
      void loadingRef.current?.destroy().catch(() => {});
      loadingRef.current = null;
      setBusy(false);
    }
  }, [disabled]);

  function fail(cause: unknown, request: number) {
    if (generation.current !== request || disabledRef.current) return;
    const name = cause instanceof Error ? cause.name : "";
    if (name === "RenderingCancelledException" || name === "AbortException")
      return;
    setError(
      name === "PasswordException"
        ? "암호화된 PDF는 지원하지 않습니다. 비밀번호를 해제한 사본을 선택해 주세요."
        : cause instanceof Error
          ? cause.message
          : "도면을 불러올 수 없습니다.",
    );
  }
  function commit(source: DrawingSource, request: number) {
    if (generation.current !== request) return;
    changeRef.current(applyDrawingSource(projectRef.current, source));
    setPoints([]);
    setPicking(false);
    setNotice(
      "도면을 배경으로 반영했습니다. 기준거리 보정과 확인 근거를 입력해 주세요. 노드·랙·장애물은 지도에서 직접 전사합니다.",
    );
  }
  async function renderPdf(
    document: PDFDocumentProxy,
    number: number,
    request: number,
  ) {
    const pdfPage = await document.getPage(number);
    let currentTask: RenderTask | undefined;
    try {
      const original = pdfPage.getViewport({ scale: 1 }),
        size = renderSize(original.width, original.height, 2);
      const viewport = pdfPage.getViewport({ scale: size.scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const task = pdfPage.render({
        canvas,
        viewport,
        background: "rgb(255,255,255)",
      });
      currentTask = task;
      renderRef.current = task;
      await task.promise;
      if (generation.current !== request) return;
      const dataUrl = canvas.toDataURL("image/png");
      if (dataUrl.length > MAX_SOURCE_DATA_URL)
        throw new Error(
          "렌더링된 페이지가 너무 큽니다. 필요한 부분을 잘라 PDF 또는 이미지로 저장해 주세요.",
        );
      const text = await pdfPage.getTextContent();
      if (generation.current !== request) return;
      const content = text.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      setCandidates(dimensionCandidates(content));
      setPage(number);
      setPageInput(String(number));
      commit(
        {
          name: pdfName.current,
          type: "pdf",
          page: number,
          dataUrl,
          widthPx: canvas.width,
          heightPx: canvas.height,
        },
        request,
      );
    } finally {
      if (renderRef.current === currentTask) renderRef.current = null;
      pdfPage.cleanup();
    }
  }
  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || disabled) return;
    const request = ++generation.current;
    renderRef.current?.cancel();
    void loadingRef.current?.destroy().catch(() => {});
    loadingRef.current = null;
    void pdfRef.current?.destroy().catch(() => {});
    pdfRef.current = null;
    setBusy(true);
    setError("");
    setNotice("");
    setPageCount(0);
    setCandidates([]);
    try {
      validateSourceFile(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation.current !== request) return;
      const format = inspectDrawingBytes(bytes);
      if (format.type === "pdf") {
        const task = pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
          useWorkerFetch: false,
          useWasm: false,
          CMapReaderFactory: LocalCMapReader,
          StandardFontDataFactory: LocalFontReader,
        });
        loadingRef.current = task;
        const document = await task.promise;
        if (generation.current !== request) {
          await document.destroy();
          return;
        }
        loadingRef.current = null;
        if (document.numPages > MAX_PDF_PAGES) {
          await document.destroy();
          throw new Error(
            "PDF는 100페이지 이하만 지원합니다. 사용할 페이지만 추출해 주세요.",
          );
        }
        pdfRef.current = document;
        pdfName.current = file.name;
        setPageCount(document.numPages);
        await renderPdf(document, 1, request);
      } else {
        const url = URL.createObjectURL(file);
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          if (generation.current !== request) return;
          const size = renderSize(image.naturalWidth, image.naturalHeight);
          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const context = canvas.getContext("2d");
          if (!context)
            throw new Error("브라우저에서 이미지 캔버스를 사용할 수 없습니다.");
          context.fillStyle = "#fff";
          context.fillRect(0, 0, size.width, size.height);
          context.drawImage(image, 0, 0, size.width, size.height);
          const dataUrl = canvas.toDataURL(
            file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)
              ? "image/jpeg"
              : "image/png",
            0.94,
          );
          commit(
            {
              name: file.name,
              type: "image",
              page: 1,
              dataUrl,
              widthPx: size.width,
              heightPx: size.height,
            },
            request,
          );
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch (cause) {
      fail(cause, request);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }
  async function selectPage(number: number) {
    if (!pdfRef.current || disabled || busy) return;
    if (!Number.isInteger(number) || number < 1 || number > pageCount) {
      setError(`1~${pageCount} 사이 페이지를 입력해 주세요.`);
      return;
    }
    if (number === page) return;
    const request = ++generation.current;
    renderRef.current?.cancel();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await renderPdf(pdfRef.current, number, request);
    } catch (cause) {
      fail(cause, request);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }
  function cancel() {
    generation.current++;
    renderRef.current?.cancel();
    renderRef.current = null;
    void loadingRef.current?.destroy().catch(() => {});
    loadingRef.current = null;
    setBusy(false);
    setNotice("불러오기를 취소했습니다. 기존 프로젝트 배경은 유지됩니다.");
  }
  function pickPoint(event: MouseEvent<SVGSVGElement>) {
    if (!picking || disabled || !source) return;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > source.widthPx ||
      point.y > source.heightPx
    )
      return;
    const next = [...points, { x: point.x, y: point.y }];
    setPoints(next);
    if (next.length === 2) {
      setPicking(false);
      try {
        changeRef.current(
          updateSourceCalibration(projectRef.current, {
            referencePixels: referenceDistance(next[0], next[1]),
            points: [next[0], next[1]],
          }),
        );
        setError("");
      } catch (cause) {
        setPoints([]);
        setError(
          cause instanceof Error
            ? cause.message
            : "기준점을 다시 선택해 주세요.",
        );
      }
    }
  }
  function calibration(patch: Partial<typeof cal>) {
    try {
      onChange(updateSourceCalibration(project, patch));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "보정값을 확인해 주세요.",
      );
    }
  }
  function setOrigin(axis: "x" | "y", value: string) {
    if (!project.background || !value.trim() || !Number.isFinite(Number(value)))
      return;
    const next = updateSourceCalibration(project, {});
    next.background![axis] = Number(value);
    onChange(next);
  }

  return (
    <section
      className="source-panel"
      aria-label="고객 도면 불러오기와 축척 검증"
    >
      <div className="source-heading">
        <div>
          <span className="source-eyebrow">01 · SOURCE DRAWING</span>
          <h3>고객 도면 · 기준거리 보정</h3>
        </div>
        <span className={`source-status ${cal.confirmed ? "confirmed" : ""}`}>
          {cal.confirmed ? "축척 확인됨" : "축척 미확정"}
        </span>
      </div>
      <p className="source-description">
        PNG/JPG 또는 PDF를 이 브라우저에서 처리합니다. 지도 객체는 배경을 따라
        직접 배치하며, 도면을 올리는 것만으로 벽·랙·높이가 자동 판독되지는
        않습니다.
      </p>
      <label className="source-upload">
        <input
          aria-label="원본 PNG JPG PDF 업로드"
          type="file"
          accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
          onChange={(event) => void openFile(event)}
          disabled={disabled || busy}
        />
        <strong>{source ? "도면 교체" : "도면 선택"}</strong>
        <span>PNG · JPG · PDF / 최대 20 MiB, PDF 100페이지</span>
      </label>
      {busy && (
        <div className="source-loading" role="status">
          도면을 읽고 있습니다…{" "}
          <button className="button small" type="button" onClick={cancel}>
            불러오기 취소
          </button>
        </div>
      )}
      {error && (
        <p className="source-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="source-notice" role="status">
          {notice}
        </p>
      )}
      {pageCount > 0 && (
        <div className="source-page-controls">
          <button
            className="button small"
            disabled={disabled || busy || page <= 1}
            onClick={() => void selectPage(page - 1)}
          >
            이전 페이지
          </button>
          <label>
            페이지{" "}
            <input
              aria-label="PDF 페이지"
              type="number"
              min="1"
              max={pageCount}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              disabled={disabled || busy}
            />
          </label>
          <span>/ {pageCount}</span>
          <button
            className="button small"
            disabled={disabled || busy}
            onClick={() => void selectPage(Number(pageInput))}
          >
            페이지 적용
          </button>
          <button
            className="button small"
            disabled={disabled || busy || page >= pageCount}
            onClick={() => void selectPage(page + 1)}
          >
            다음 페이지
          </button>
        </div>
      )}
      {source && (
        <>
          <div className="source-file">
            <strong>{source.name}</strong>
            <span>
              {source.type === "pdf" ? `PDF ${source.page}페이지 · ` : ""}
              {source.widthPx} × {source.heightPx} px
            </span>
          </div>
          {source.type === "pdf" && pageCount === 0 && (
            <p className="source-note">
              저장된 프로젝트에는 선택 페이지 이미지만 포함됩니다. 다른 페이지를
              열려면 원본 PDF를 다시 선택해 주세요.
            </p>
          )}
          <div className={`source-stage ${picking ? "picking" : ""}`}>
            <svg
              role="img"
              aria-label="기준점 선택용 원본 도면"
              viewBox={`0 0 ${source.widthPx} ${source.heightPx}`}
              onClick={pickPoint}
            >
              <image
                href={source.dataUrl}
                width={source.widthPx}
                height={source.heightPx}
              />
              {points.length === 2 && (
                <line
                  x1={points[0].x}
                  y1={points[0].y}
                  x2={points[1].x}
                  y2={points[1].y}
                  stroke="#ef4444"
                  strokeWidth={Math.max(2, source.widthPx / 350)}
                />
              )}
              {points.map((point, index) => (
                <g key={index}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={Math.max(5, source.widthPx / 80)}
                    fill="#ef4444"
                    stroke="white"
                    strokeWidth={Math.max(1, source.widthPx / 700)}
                  />
                  <text
                    x={point.x}
                    y={point.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize={Math.max(8, source.widthPx / 80)}
                    fontWeight="700"
                  >
                    {index + 1}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="source-calibrate-row">
            <button
              className="button small"
              disabled={disabled || busy}
              onClick={() => {
                setPoints([]);
                setPicking(true);
                calibration({ referencePixels: null });
              }}
            >
              기준점 2개 지정
            </button>
            <span>
              {picking
                ? `${points.length + 1}번째 기준점을 도면에서 클릭하세요.`
                : cal.referencePixels !== null
                  ? `선택 거리 ${nice(cal.referencePixels)} px`
                  : "알려진 치수의 양 끝을 선택하세요."}
            </span>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>실제 기준거리 (m)</span>
              <input
                aria-label="실제 기준거리 m"
                type="number"
                min="0.001"
                step="any"
                value={cal.referenceMeters ?? ""}
                disabled={disabled || busy}
                placeholder="예: 10"
                onChange={(e) =>
                  calibration({
                    referenceMeters:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
              <small>
                예: 도면 10,000 mm → 10 m. 기준선은 길게 지정합니다.
              </small>
            </label>
            <div className="source-scale">
              <span>계산 축척</span>
              <strong>
                {scale === null ? "미보정" : `${nice(scale)} m/px`}
              </strong>
              <small>
                {scale !== null && project.background
                  ? `배경 ${nice(project.background.width)} × ${nice(project.background.height)} m`
                  : "보정 전 배경 크기는 임시 표시값입니다."}
              </small>
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>배경 기준점 X (m)</span>
              <input
                aria-label="도면 배경 X m"
                type="number"
                step="any"
                value={project.background?.x ?? 0}
                disabled={disabled || busy}
                onChange={(e) => setOrigin("x", e.target.value)}
              />
            </label>
            <label className="field">
              <span>배경 기준점 Y (m)</span>
              <input
                aria-label="도면 배경 Y m"
                type="number"
                step="any"
                value={project.background?.y ?? 0}
                disabled={disabled || busy}
                onChange={(e) => setOrigin("y", e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>축척 확인 근거</span>
            <input
              aria-label="축척 확인 근거"
              value={cal.evidence}
              disabled={disabled || busy}
              placeholder="예: 고객 도면 A-01의 외벽 10,000 mm 치수선"
              onChange={(e) => calibration({ evidence: e.target.value })}
            />
          </label>
          <label className="checkbox-field source-confirm">
            <input
              type="checkbox"
              aria-label="축척과 기준거리 확인"
              checked={cal.confirmed}
              disabled={
                disabled || busy || scale === null || !cal.evidence.trim()
              }
              onChange={(e) => {
                try {
                  onChange(confirmSourceCalibration(project, e.target.checked));
                  setError("");
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "확인 근거가 필요합니다.",
                  );
                }
              }}
            />
            <span>원본 치수와 선택 구간·단위를 대조했습니다. (축척 확인)</span>
          </label>
          {source.type === "pdf" && (
            <div className="source-text-hints">
              <strong>PDF 텍스트층의 치수 참고 문구</strong>
              <p>
                {candidates.length
                  ? candidates.join(" · ")
                  : "단위가 포함된 치수 문구를 찾지 못했습니다. 스캔 PDF에는 텍스트층이 없을 수 있습니다."}
              </p>
              <small>
                위 문구는 자동 검증·OCR 결과가 아닙니다. 어느 구간의 치수인지,
                축척과 단위가 맞는지 원본을 확인해야 합니다.
              </small>
            </div>
          )}
        </>
      )}
      <div className="source-height-note">
        <strong>층고는 별도 근거로 확인해야 합니다</strong>
        <p>
          평면 이미지/PDF만으로 유효 층고, 보·스프링클러 하부 높이 또는 랙 적층
          가능 높이를 추정하지 않습니다. 현장 실측·단면도·고객 확인 근거를 공간
          검토에 입력해 주세요.
        </p>
      </div>
    </section>
  );
}
