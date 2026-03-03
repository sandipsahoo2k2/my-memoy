import { Injectable } from '@angular/core';

export interface OpenAiSettings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  summaryTime?: string; // e.g. '17:00'
}

@Injectable({
  providedIn: 'root'
})
export class OpenAiService {
  private readonly SETTINGS_KEY = 'deskgremlin_openai_settings';

  private readonly VALIDATED_KEY = 'deskgremlin_openai_validated';

  constructor() { }

  isValidated(): boolean {
    return localStorage.getItem(this.VALIDATED_KEY) === 'true';
  }

  resetValidation() {
    localStorage.removeItem(this.VALIDATED_KEY);
  }

  loadSettings(): OpenAiSettings {
    const defaultSettings: OpenAiSettings = {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      summaryTime: '17:00'
    };
    const saved = localStorage.getItem(this.SETTINGS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { ...defaultSettings, ...parsed };
      } catch (e) {
        console.error('Failed to parse OpenAI settings', e);
      }
    }
    return defaultSettings;
  }

  saveSettings(settings: OpenAiSettings) {
    const old = this.loadSettings();
    // If key or baseURL changed, we must re-validate before background scheduler starts
    if (old.apiKey !== settings.apiKey || old.baseUrl !== settings.baseUrl) {
      this.resetValidation();
    }

    // Basic cleanup of baseUrl
    if (settings.baseUrl && settings.baseUrl.endsWith('/')) {
      settings.baseUrl = settings.baseUrl.slice(0, -1);
    }
    if (settings.baseUrl && settings.baseUrl.endsWith('/chat/completions')) {
      settings.baseUrl = settings.baseUrl.replace(/\/chat\/completions$/, '');
    }
    localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
  }

  async summarizeNotes(notes: string[]): Promise<string | null> {
    const settings = this.loadSettings();
    if (!settings.enabled || !settings.apiKey || notes.length === 0) {
      return null;
    }

    const payload = {
      model: settings.model || 'gpt-4o-mini',
      messages: [
        {
          role: "system",
          content: "You are a 'Daily Mind' summarizing expert. Your task is to consolidate a list of fragmented thoughts and notes from today into ONE cohesive, insightful summary. Focus on core themes, key tasks completed, and the general mood. Keep it under 200 words.\nCRITICAL: The summary MUST start with the EXACT markdown title '#### 🌟 Today's Reflection'. Do NOT use # or ##. Use FOUR hashtags for an H4 size header."
        },
        {
          role: "user",
          content: "Today's notes:\n" + notes.join("\n---\n")
        }
      ],
      temperature: 0.7
    };

    try {
      console.log('🤖 AI Summary: Starting consolidation of', notes.length, 'notes...');
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const body = await response.text();
        console.error('❌ AI Summary API Error:', response.status, body);
        throw new Error(`Summary failed: ${response.status}`);
      }

      const data = await response.json();
      console.log('✅ AI Summary: Successfully generated.');
      localStorage.setItem(this.VALIDATED_KEY, 'true'); // <--- Marked as successful atleast once
      return data.choices[0].message.content;
    } catch (e) {
      console.error('❌ AI Summary Exception:', e);
      return null;
    }
  }

  async enrichNote(content: string): Promise<{ category: string, labels: string[], rejected?: boolean } | null> {
    const settings = this.loadSettings();
    if (!settings.enabled || !settings.apiKey) {
      return null;
    }

    // Do not process very short or meaningless messages (like V0)
    const words = content.trim().split(/\s+/);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));

    const payload = {
      model: settings.model || 'gpt-4o-mini',
      messages: [
        {
          role: "system",
          content: "You are an AI assistant in a note-taking app. Your job is to analyze the user's note and return a JSON object with two fields:\n1) 'category': Must be ONE of ['tech', 'review', 'casual', 'finance', 'idea', 'todo', 'journal', 'learning']. Pick the most appropriate. Hardware, code, tech kits, pi, domains, and URLs must be categorized as 'tech'.\n2) 'labels': An array of strings containing EXACTLY 1 short hashtag relevant to the note (without the # prefix). ALERTS: The label MUST be very small (MAX 5-6 characters, e.g. 'pi' or 'python').\nCRITICAL: If the text is completely meaningless gibberish, repeated words, a simple greeting like 'hello' or 'hi', or not a real thought/memory, you MUST add a third field 'rejected': true and leave the others empty.\nRespond ONLY in valid JSON. Example: {\"category\": \"tech\", \"labels\": [\"python\"]}"
        },
        {
          role: "user",
          content: content
        }
      ],
      temperature: 0.2
    };

    try {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      let resultText = data.choices[0].message.content;

      // Handle OpenRouter cases where models wrap JSON in markdown blocks
      if (resultText.includes('```json')) {
        resultText = resultText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      } else if (resultText.includes('```')) {
        resultText = resultText.replace(/```\n?/g, '').trim();
      }

      const parsed = JSON.parse(resultText);
      localStorage.setItem(this.VALIDATED_KEY, 'true'); // <--- Marked as successful atleast once

      return {
        category: parsed.category || 'casual',
        labels: Array.isArray(parsed.labels) ? parsed.labels : [],
        rejected: parsed.rejected === true
      };
    } catch (error) {
      console.error('Failed to call OpenAI:', error);
      return null;
    }
  }

  async askAi(prompt: string, context: string): Promise<string | null> {
    const settings = this.loadSettings();
    if (!settings.enabled || !settings.apiKey) {
      return "AI is not configured. Please enable it in settings.";
    }

    const payload = {
      model: settings.model || 'gpt-4o-mini',
      messages: [
        {
          role: "system",
          content: "You are an AI assistant helping a team member with their notes. Use the provided context from the team's documentation to answer the user's question accurately. If the answer is not in the context, inform the user but try to be helpful based on general knowledge if appropriate, while noting that it's not in the documentation.\nKeep your answers concise, professional, and well-formatted using markdown."
        },
        {
          role: "user",
          content: `Context from team notes:\n${context}\n\nUser Question: ${prompt}`
        }
      ],
      temperature: 0.5
    };

    try {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      localStorage.setItem(this.VALIDATED_KEY, 'true');
      return data.choices[0].message.content;
    } catch (error) {
      console.error('Failed to call OpenAI:', error);
      return "Sorry, I encountered an error while processing your request.";
    }
  }
}
