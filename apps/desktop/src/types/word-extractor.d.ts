/** word-extractor 无自带类型（CJS module.exports = class），补一个最小声明供 doc-parse 使用 */
declare module 'word-extractor' {
  export interface WordDocument {
    getBody(): string;
    getHeaders(): string;
    getFootnotes(): string;
    getAnnotations(): string;
    getComments(): string;
    getTextboxes(): string;
    getHyperlinks(): string[];
  }
  export default class WordExtractor {
    extract(path: string): Promise<WordDocument>;
  }
}
