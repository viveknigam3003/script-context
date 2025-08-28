import { useState, useCallback } from "react";
import Editor from "@monaco-editor/react";
import "./App.css";

function App() {
  const [inputCode, setInputCode] = useState("");
  const [outputCode, setOutputCode] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [isExtracting, setIsExtracting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  // Function for processing code using the context builder
  const extractScript = useCallback(async () => {
    setIsExtracting(true);
    setSuccessMessage("");

    try {
      // Clear previous errors
      setErrors([]);

      // Basic syntax validation
      if (!inputCode.trim()) {
        setOutputCode("// No input provided");
        setErrors(["No input code provided"]);
        return;
      }

      // Use the context builder to process the code
      const input: BuildContextInput = {
        source: inputCode,
        cursor: cursor,
      };

      const options: BuildContextOptions = {
        maxChars: 2048, // Updated to use character limit following spec
      };

      const result = await buildContext(input, options); // Display the extracted context
      setOutputCode(result.text);
      setExtractionStats(result.stats);
      setSuccessMessage("✅ Context extracted successfully!");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      setErrors([errorMessage]);
      setOutputCode("// Error occurred during context extraction");
      setSuccessMessage("");
      setExtractionStats(null);
    } finally {
      setIsExtracting(false);
    }
  }, [inputCode, cursor]);

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
                  Cursor: Line {cursor.line}, Column {cursor.column}
                </span>
              </div>
            </div>
            <div className="editor-wrapper">
              <Editor
                height="400px"
                defaultLanguage="typescript"
                value={inputCode}
                onChange={(value) => setInputCode(value || "")}
                onMount={(editor) => {
                  // Track cursor position changes
                  editor.onDidChangeCursorPosition((e) => {
                    setCursor({
                      line: e.position.lineNumber,
                      column: e.position.column,
                    });
                  });
                }}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  tabSize: 2,
                  automaticLayout: true,
                  wordWrap: "on",
                }}
              />
            </div>
          </div>

          <div className="editor-section">
            <h2>Output Code</h2>
            <div className="editor-wrapper">
              <Editor
                height="400px"
                defaultLanguage="typescript"
                value={outputCode}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 14,
                  tabSize: 2,
                  automaticLayout: true,
                  wordWrap: "on",
                }}
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
              <h3>Smart Extraction Statistics</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Tests:</span>
                  <span className="stat-value">
                    {extractionStats.testsIncluded}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Definitions:</span>
                  <span className="stat-value">
                    {extractionStats.definitionsIncluded}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Characters:</span>
                  <span className="stat-value">
                    {extractionStats.totalChars}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Content Capped:</span>
                  <span className="stat-value">
                    {extractionStats.capped ? "Yes" : "No"}
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
