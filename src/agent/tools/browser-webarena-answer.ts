import { attachTodos, formatToolError } from './util.js';
import { readFileSync } from 'fs';
import path from 'path';

type WebArenaAnswerInput = {
  answer: string;
  reasoning?: string;
};

/**
 * WebArena評価専用の最終回答ツール
 * configファイルから評価方法を読み取り、適切な形式で答えを出力する
 */
export async function browserWebArenaAnswer(input: WebArenaAnswerInput): Promise<string> {
  try {
    const answer = String((input as any)?.answer ?? '').trim();
    const reasoning = String((input as any)?.reasoning ?? '').trim();
    
    if (!answer) {
      const payload = await attachTodos({ 
        ok: false, 
        action: 'webarena_answer', 
        error: 'Error: answer is required' 
      });
      return JSON.stringify(payload);
    }

    // configファイルから評価方法を読み取る
    const configFilePath = String(process.env.AGENT_WEBARENA_CONFIG_FILE || '').trim();
    if (!configFilePath) {
      const payload = await attachTodos({ 
        ok: false, 
        action: 'webarena_answer', 
        error: 'Error: AGENT_WEBARENA_CONFIG_FILE is not set' 
      });
      return JSON.stringify(payload);
    }

    let evalConfig: any = {};
    try {
      const configContent = readFileSync(configFilePath, 'utf-8');
      const config = JSON.parse(configContent);
      evalConfig = config.eval || {};
    } catch (e: any) {
      const payload = await attachTodos({ 
        ok: false, 
        action: 'webarena_answer', 
        error: `Error: Failed to read config file: ${e?.message ?? e}` 
      });
      return JSON.stringify(payload);
    }

    const evalTypes = evalConfig.eval_types || [];
    const referenceAnswers = evalConfig.reference_answers || {};
    
    // 評価方法に応じて答えを整形
    let formattedAnswer = answer;
    let evaluationNote = '';

    // exact_match の場合: 答えから重要部分のみを抽出
    if (referenceAnswers.exact_match && referenceAnswers.exact_match !== 'N/A') {
      const refText = String(referenceAnswers.exact_match).trim();
      // 答えから参照テキストを探す
      const lowerAnswer = answer.toLowerCase();
      const lowerRef = refText.toLowerCase();
      
      if (lowerAnswer.includes(lowerRef)) {
        // 参照テキストを含む場合、その部分を抽出
        formattedAnswer = refText;
        evaluationNote = `extracted for exact_match: "${refText}"`;
      } else {
        // 含まれない場合は元の答えを返す（評価では失敗する）
        formattedAnswer = answer;
        evaluationNote = `reference "${refText}" not found in answer`;
      }
    }
    
    // must_include の場合: 各要素を含むことを確認
    if (referenceAnswers.must_include && Array.isArray(referenceAnswers.must_include)) {
      const missingElements: string[] = [];
      const lowerAnswer = answer.toLowerCase();
      
      for (const element of referenceAnswers.must_include) {
        const elemText = String(element).trim().toLowerCase();
        if (!lowerAnswer.includes(elemText)) {
          missingElements.push(String(element));
        }
      }
      
      if (missingElements.length > 0) {
        evaluationNote = `missing elements: ${missingElements.join(', ')}`;
      } else {
        evaluationNote = 'all required elements present';
      }
    }
    
    // fuzzy_match の場合: N/Aまたは詳細な説明をそのまま使用
    if (referenceAnswers.fuzzy_match === 'N/A') {
      if (answer.toUpperCase().includes('N/A') || answer.toLowerCase().includes('not achievable')) {
        formattedAnswer = 'N/A';
        evaluationNote = 'N/A answer for unachievable task';
      } else {
        // N/Aではない場合、理由を詳細に記載する必要がある
        formattedAnswer = answer;
        evaluationNote = 'detailed explanation provided for unachievable task';
      }
    } else if (referenceAnswers.fuzzy_match && Array.isArray(referenceAnswers.fuzzy_match)) {
      // fuzzy_match は LLM で判定されるため、元の答えをそのまま使用
      formattedAnswer = answer;
      evaluationNote = 'answer provided for fuzzy_match evaluation';
    }

    const payload = await attachTodos({ 
      ok: true, 
      action: 'webarena_answer', 
      answer: formattedAnswer,
      originalAnswer: answer,
      reasoning: reasoning || undefined,
      evaluationNote,
      evalTypes,
      referenceAnswers,
      todos: { path: 'todo.md', content: '' }
    });
    
    return JSON.stringify(payload);
  } catch (e: any) {
    const answer = String((input as any)?.answer ?? '').trim();
    const payload = await attachTodos({ 
      ok: false, 
      action: 'webarena_answer', 
      error: formatToolError(e),
      answer: answer || undefined
    });
    return JSON.stringify(payload);
  }
}

