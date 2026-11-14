import type {
    FileToolOptions,
    FileToolRecipe,
    FileToolSource,
} from "../../lib/fileTools";

export interface ToolInput extends FileToolSource {
    path: string;
}

export interface ToolContext {
    inputs: ToolInput[];
    recipe: string;
    options: FileToolOptions;
    outputDir: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
}

export interface ToolEngineResult {
    paths: string[];
    warnings?: string[];
}

export interface FileToolEngine {
    recipes(inputs: ToolInput[]): Promise<FileToolRecipe[]> | FileToolRecipe[];
    run(context: ToolContext): Promise<ToolEngineResult>;
}
