import CoreMLLLM
import Darwin
import Foundation
import Tokenizers

enum LoadedModel {
    case generic(CoreMLLLM)
    case qwen(Qwen35MLKVGenerator, any Tokenizer)

    static func load(_ name: String, allowDownload: Bool = false) async throws -> LoadedModel {
        let directory: URL
        let expanded = (name as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") || expanded.hasPrefix("./") || expanded.hasPrefix("../") {
            directory = URL(fileURLWithPath: expanded)
        } else {
            // Qwen3.5 bundles require the dedicated MLKV generator, as in
            // upstream's LLMRunner; CoreMLLLM.load expects a generic config.
            guard let info = ModelDownloader.ModelInfo.defaults.first(where: {
                $0.id.lowercased() == name.lowercased() ||
                $0.downloadURL.lowercased().contains(name.lowercased())
            }) else { throw BridgeError.unknownModel(name) }
            let cached = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Models").appendingPathComponent(info.folderName)
            let qwenFolder = cached.appendingPathComponent(
                info.id == "qwen3.5-0.8b" ? "qwen3_5_0_8b_decode_chunks_mlkv" : "qwen3_5_2b_decode_chunks_mlkv")
            let fm = FileManager.default
            let qwenReady = ["embed_weight.bin"] + ["a", "b", "c", "d"].map {
                "chunk_\($0).mlpackage/Data/com.apple.CoreML/weights/weight.bin"
            }
            // Avoid creating upstream's shared background download session in
            // inference workers; another process may be preparing a model.
            if qwenReady.allSatisfy({ fm.fileExists(atPath: qwenFolder.appendingPathComponent($0).path) }) ||
               fm.fileExists(atPath: cached.appendingPathComponent("model_config.json").path) {
                directory = cached
            } else {
                guard allowDownload else { throw BridgeError.modelNotPrepared(name) }
                fputs("Downloading \(info.name)...\n", stderr)
                let modelURL = try await ModelDownloader.shared.download(info)
                directory = modelURL.deletingLastPathComponent()
            }
        }
        let small = directory.appendingPathComponent("qwen3_5_0_8b_decode_chunks_mlkv")
        let large = directory.appendingPathComponent("qwen3_5_2b_decode_chunks_mlkv")
        let fm = FileManager.default
        let isSmall = fm.fileExists(atPath: small.appendingPathComponent("embed_weight.bin").path)
        if isSmall || fm.fileExists(atPath: large.appendingPathComponent("embed_weight.bin").path) {
            fputs("Loading Qwen tokenizer and compiling Core ML chunks...\n", stderr)
            let tokenizer = try await AutoTokenizer.from(
                pretrained: isSmall ? "Qwen/Qwen3.5-0.8B" : "Qwen/Qwen3.5-2B")
            let generator = Qwen35MLKVGenerator(cfg: isSmall ? .default0_8B : .default2B)
            generator.setModelFolder(directory)
            try await generator.load()
            return .qwen(generator, tokenizer)
        }
        return .generic(try await CoreMLLLM.load(from: directory))
    }

    func generate(_ prompt: String, maxTokens: Int) async throws -> String {
        switch self {
        case .generic(let model):
            return try await model.generate(prompt, maxTokens: maxTokens)
        case .qwen(let generator, let tokenizer):
            let input = try tokenizer.applyChatTemplate(
                messages: [["role": "user", "content": prompt]], tools: nil,
                additionalContext: ["enable_thinking": false])
            let remaining = 2048 - input.count - 1
            guard remaining > 0 else { throw BridgeError.promptTooLong(input.count) }
            var eos: Set<Int32> = [248044, 248045, 248046]
            if let id = tokenizer.eosTokenId { eos.insert(Int32(id)) }
            let output = try await generator.generate(
                inputIds: input.map { Int32($0) }, maxNewTokens: min(maxTokens, remaining),
                temperature: 0, topP: 1, eosTokenIds: eos)
            return tokenizer.decode(tokens: output.filter { !eos.contains($0) }.map { Int($0) },
                                    skipSpecialTokens: true)
        }
    }
}

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
                let models = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("Models")
                try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
                let lock = open(models.appendingPathComponent(".sweetiebot-prepare.lock").path,
                                O_CREAT | O_RDWR, 0o600)
                guard lock >= 0 else { throw BridgeError.preparationBusy }
                defer { close(lock) }
                guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw BridgeError.preparationBusy }
                _ = try await LoadedModel.load(CommandLine.arguments[2], allowDownload: true)
                emit(["response": "Model ready", "done_reason": "stop"], to: output)
            } catch {
                fputs("Failed to prepare Core ML model: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
            return
        }

        guard CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--serve" else {
            fputs("Usage: sweetiebot-ane --prepare MODEL | --serve\n", stderr)
            exit(2)
        }

        var models: [String: LoadedModel] = [:]
        while let line = readLine(strippingNewline: true) {
            do {
                guard let bytes = line.data(using: .utf8),
                      let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let modelName = value["model"] as? String, !modelName.isEmpty,
                      let prompt = value["prompt"] as? String, !prompt.isEmpty else {
                    throw BridgeError.invalidRequest
                }
                let model: LoadedModel
                if let loaded = models[modelName] {
                    model = loaded
                } else {
                    let loaded = try await LoadedModel.load(modelName)
                    models[modelName] = loaded
                    model = loaded
                }
                let tokens = max(16, min(1024, value["max_tokens"] as? Int ?? 256))
                let answer = try await model.generate(prompt, maxTokens: tokens)
                emit(["response": answer, "done_reason": "stop"], to: output)
            } catch {
                emit(["response": "", "error": error.localizedDescription], to: output)
            }
        }
    }
}

enum BridgeError: Error, LocalizedError {
    case invalidRequest
    case unknownModel(String)
    case promptTooLong(Int)
    case modelNotPrepared(String)
    case preparationBusy

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Expected a nonempty model and prompt."
        case .unknownModel(let name): return "Unknown Core ML model: \(name)."
        case .promptTooLong(let count): return "Qwen prompt has \(count) tokens; its context limit is 2048."
        case .modelNotPrepared(let name): return "Run sweetiebot-ane --prepare \(name) before generating."
        case .preparationBusy: return "Another model preparation is running, or its lock cannot be opened."
        }
    }
}
