import CoreMLLLM
import Darwin
import Foundation

// The CoreML-LLM package may print diagnostics. Preserve a clean JSON-lines
// protocol by moving all ordinary stdout to stderr before model loading.
@main
struct SweetiebotANE {
    static func emit(_ value: [String: Any], to output: FileHandle) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let line = String(data: data, encoding: .utf8) else { return }
        output.write(Data((line + "\n").utf8))
    }

    static func main() async {
        let protocolFD = dup(STDOUT_FILENO)
        guard protocolFD >= 0 else { exit(1) }
        _ = dup2(STDERR_FILENO, STDOUT_FILENO)
        let output = FileHandle(fileDescriptor: protocolFD, closeOnDealloc: true)

        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--prepare" {
            do {
                _ = try await CoreMLLLM.load(repo: CommandLine.arguments[2])
                emit(["response": "Model ready", "done_reason": "stop"], to: output)
            } catch {
                fputs("Failed to prepare Core ML model: \(error)\n", stderr)
                exit(1)
            }
            return
        }

        guard CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--serve" else {
            fputs("Usage: sweetiebot-ane --prepare MODEL | --serve\n", stderr)
            exit(2)
        }

        var models: [String: CoreMLLLM] = [:]
        while let line = readLine(strippingNewline: true) {
            do {
                guard let bytes = line.data(using: .utf8),
                      let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let modelName = value["model"] as? String, !modelName.isEmpty,
                      let prompt = value["prompt"] as? String, !prompt.isEmpty else {
                    throw BridgeError.invalidRequest
                }
                let model: CoreMLLLM
                if let loaded = models[modelName] {
                    model = loaded
                } else {
                    let loaded: CoreMLLLM
                    if modelName.hasPrefix("/") || modelName.hasPrefix("./") ||
                       modelName.hasPrefix("../") {
                        loaded = try await CoreMLLLM.load(
                            from: URL(fileURLWithPath: (modelName as NSString).expandingTildeInPath))
                    } else {
                        loaded = try await CoreMLLLM.load(repo: modelName)
                    }
                    models[modelName] = loaded
                    model = loaded
                }
                let tokens = max(16, min(1024, value["max_tokens"] as? Int ?? 256))
                let answer = try await model.generate(prompt, maxTokens: tokens)
                emit(["response": answer, "done_reason": "stop"], to: output)
            } catch {
                emit(["response": "", "error": String(describing: error)], to: output)
            }
        }
    }
}

enum BridgeError: Error {
    case invalidRequest
}
