import { useState, useCallback, useEffect, useRef } from "react";
import { monaco } from "./lib/monacoSetup";
import { ContextExtractor } from "./lib/context";
import "./App.css";

function App() {
  const [errors, setErrors] = useState<string[]>([]);
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [isExtracting, setIsExtracting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [extractionStats, setExtractionStats] = useState<{
    strategy: string;
    totalChars: number;
  } | null>(null);

  // Monaco editor refs
  const inputEditorRef = useRef<HTMLDivElement>(null);
  const outputEditorRef = useRef<HTMLDivElement>(null);
  const inputEditorInstance =
    useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const outputEditorInstance =
    useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const contextExtractor = useRef<ContextExtractor | null>(null);
  const modelDisposable = useRef<monaco.IDisposable | null>(null);

  // Initialize Monaco editors
  useEffect(() => {
    const initializeEditors = async () => {
      console.log("Starting editor initialization...");

      if (!inputEditorRef.current || !outputEditorRef.current) {
        console.log("Editor refs not ready yet");
        return;
      }

      try {
        console.log("Creating Monaco model...");
        const model = monaco.editor.createModel("", "javascript");
        console.log("Model created successfully");

        console.log("Creating input editor...");
        inputEditorInstance.current = monaco.editor.create(
          inputEditorRef.current,
          {
            model,
            theme: "vs-dark",
            language: "javascript",
            minimap: { enabled: false },
            fontSize: 14,
            tabSize: 2,
            automaticLayout: true,
            wordWrap: "on",
          }
        );
        console.log("Input editor created successfully");

        console.log("Creating output editor...");
        const outputModel = monaco.editor.createModel("", "javascript");
        outputEditorInstance.current = monaco.editor.create(
          outputEditorRef.current,
          {
            model: outputModel,
            theme: "vs-dark",
            language: "javascript",
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 14,
            tabSize: 2,
            automaticLayout: true,
            wordWrap: "on",
          }
        );
        console.log("Output editor created successfully");

        console.log("Setting up cursor tracking...");
        inputEditorInstance.current.onDidChangeCursorPosition((e) => {
          setCursor({
            lineNumber: e.position.lineNumber,
            column: e.position.column,
          });
        });

        console.log("Initializing context extractor...");
        try {
          // Remove the hardcoded WASM path parameter
          contextExtractor.current = await ContextExtractor.create(model);
          console.log("Context extractor initialized successfully");

          modelDisposable.current = model.onDidChangeContent((e) => {
            if (contextExtractor.current) {
              contextExtractor.current.onModelContentChanged(e);
            }
          });
        } catch (wasmError) {
          console.warn("Failed to initialize context extractor:", wasmError);
          // Continue without context extractor for now
        }

        console.log("All editors initialized successfully!");
      } catch (error) {
        console.error("Failed to initialize Monaco editors:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setErrors([`Failed to initialize code editors: ${errorMessage}`]);
      }
    };

    initializeEditors();

    // Cleanup
    return () => {
      modelDisposable.current?.dispose();
      inputEditorInstance.current?.dispose();
      outputEditorInstance.current?.dispose();
    };
  }, []);

  // Function for processing code using the context extractor
  const extractScript = useCallback(async () => {
    setIsExtracting(true);
    setSuccessMessage("");

    try {
      setErrors([]);

      if (!inputEditorInstance.current) {
        setErrors(["Editor not initialized"]);
        return;
      }

      if (!contextExtractor.current) {
        setErrors(["Context extractor not available - WASM loading failed"]);
        return;
      }

      const model = inputEditorInstance.current.getModel();
      if (!model) {
        setErrors(["No input model available"]);
        return;
      }

      const inputText = model.getValue();
      if (!inputText.trim()) {
        const outputModel = outputEditorInstance.current?.getModel();
        if (outputModel) {
          outputModel.setValue("// No input provided");
        }
        setErrors(["No input code provided"]);
        return;
      }

      // Get current cursor position
      const position = inputEditorInstance.current.getPosition();
      if (!position) {
        setErrors(["Could not get cursor position"]);
        return;
      }

      // Extract context using the context extractor
      const result = contextExtractor.current.getContextAroundCursor(position, {
        fallbackLineWindow: 6,
      });

      // Display the extracted context
      setExtractionStats({
        strategy: result.strategy,
        totalChars: result.text.length,
      });

      // Update output editor
      if (outputEditorInstance.current) {
        const outputModel = outputEditorInstance.current.getModel();
        if (outputModel) {
          outputModel.setValue(result.text);
        }
      }

      setSuccessMessage("✅ Context extracted successfully!");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      setErrors([errorMessage]);

      // Update output editor with error message
      if (outputEditorInstance.current) {
        const outputModel = outputEditorInstance.current.getModel();
        if (outputModel) {
          outputModel.setValue("// Error occurred during context extraction");
        }
      }

      setSuccessMessage("");
      setExtractionStats(null);
    } finally {
      setIsExtracting(false);
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Context Script Module</h1>
        <p>
          Extract the most relevant script for the input based on cursor
          location
        </p>
      </header>

      <main className="app-main">
        <div className="editor-container">
          <div className="editor-section">
            <div className="editor-header">
              <h2>Input Code</h2>
              <div className="cursor-display">
                <span className="cursor-info">
                  Cursor: Line {cursor.lineNumber}, Column {cursor.column}
                </span>
              </div>
            </div>
            <div className="editor-wrapper">
              <div
                ref={inputEditorRef}
                style={{ height: "400px", width: "100%" }}
              />
            </div>
          </div>

          <div className="editor-section">
            <h2>Output Code</h2>
            <div className="editor-wrapper">
              <div
                ref={outputEditorRef}
                style={{ height: "400px", width: "100%" }}
              />
            </div>
          </div>
        </div>

        <div className="extract-section">
          <button
            className="extract-button"
            onClick={extractScript}
            disabled={isExtracting}
          >
            {isExtracting ? "Extracting..." : "Extract Script"}
          </button>
          {successMessage && (
            <div className="success-message">{successMessage}</div>
          )}

          {extractionStats && (
            <div className="stats-section">
              <h3>Context Extraction Statistics</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Strategy:</span>
                  <span className="stat-value">{extractionStats.strategy}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Characters:</span>
                  <span className="stat-value">
                    {extractionStats.totalChars}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {errors.length > 0 && (
          <div className="errors-section">
            <h3>Errors & Issues</h3>
            <div className="errors-list">
              {errors.map((error, index) => (
                <div key={index} className="error-item">
                  <span className="error-icon">⚠️</span>
                  <span className="error-message">{error}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
