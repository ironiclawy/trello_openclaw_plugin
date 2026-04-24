import { TrelloClient } from './client';
type GeneratedImage = { buffer: Buffer; mimeType: string; filename: string };

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) throw new Error('Invalid data URL image payload');
  return {
    mimeType: m[1],
    buffer: Buffer.from(m[2], 'base64'),
  };
}

async function downloadImageToBuffer(url: string, fallbackMimeType = 'image/jpeg'): Promise<GeneratedImage> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status})`);
  }
  const mimeType = response.headers.get('content-type') || fallbackMimeType;
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extensionFromMimeType(mimeType);
  return { buffer, mimeType, filename: `generated-image.${ext}` };
}

async function generateImageViaOpenAI(prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const size = process.env.OPENAI_IMAGE_SIZE || '1024x1024';

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      quality: 'high',
      output_format: 'png',
      response_format: 'b64_json',
      n: 1,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI image API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as any;
  const item = data?.data?.[0];
  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, 'base64'),
      mimeType: 'image/png',
      filename: 'generated-image.png',
    };
  }
  if (item?.url) {
    return downloadImageToBuffer(item.url, 'image/png');
  }
  throw new Error('OpenAI image API returned no image data');
}

async function generateImageViaAnthropic(prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Preferred path when Anthropic image generation endpoint is available.
  const imageModel = process.env.ANTHROPIC_IMAGE_MODEL || 'claude-image-1';
  const imageResponse = await fetch('https://api.anthropic.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: imageModel, prompt, size: '1024x1024', n: 1, response_format: 'b64_json' }),
  });

  if (imageResponse.ok) {
    const data = await imageResponse.json() as any;
    const item = data?.data?.[0];
    if (item?.b64_json) {
      return {
        buffer: Buffer.from(item.b64_json, 'base64'),
        mimeType: 'image/png',
        filename: 'generated-image.png',
      };
    }
    if (item?.url) {
      return downloadImageToBuffer(item.url, 'image/png');
    }
    throw new Error('Anthropic image API returned no image data');
  }

  const endpointErr = await imageResponse.text();

  // Fallback path: messages endpoint if model emits image blocks.
  const textModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const msgResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: textModel,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Generate a single image for this prompt and return it as image output (not markdown): ${prompt}`,
      }],
    }),
  });

  if (!msgResponse.ok) {
    throw new Error(
      `Anthropic image generation unavailable. images endpoint: ${imageResponse.status} ${endpointErr}; messages fallback: ${msgResponse.status} ${await msgResponse.text()}`
    );
  }

  const data = await msgResponse.json() as any;
  const content = Array.isArray(data?.content) ? data.content : [];
  const imageBlock = content.find((c: any) => c?.type === 'image' && c?.source);
  if (!imageBlock) {
    throw new Error('Anthropic messages response did not include an image block');
  }

  const source = imageBlock.source;
  if (source.type === 'base64' && source.data) {
    const mimeType = source.media_type || 'image/png';
    const ext = extensionFromMimeType(mimeType);
    return {
      buffer: Buffer.from(source.data, 'base64'),
      mimeType,
      filename: `generated-image.${ext}`,
    };
  }

  if (source.type === 'url' && source.url) {
    return downloadImageToBuffer(source.url, source.media_type || 'image/png');
  }

  throw new Error('Anthropic image block had unsupported source type');
}

async function generateImageViaXAI(prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not set');
  const model = process.env.XAI_IMAGE_MODEL || 'grok-imagine-image';

  const response = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, prompt, n: 1, response_format: 'url' }),
  });
  if (!response.ok) {
    throw new Error(`xAI image API error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const imageUrl: string | undefined = data?.data?.[0]?.url;
  const mimeType: string = data?.data?.[0]?.mime_type || 'image/jpeg';
  if (!imageUrl) throw new Error('xAI image API returned no image URL');
  const downloaded = await downloadImageToBuffer(imageUrl, mimeType);
  const ext = extensionFromMimeType(downloaded.mimeType);
  return {
    ...downloaded,
    filename: `generated-image.${ext}`,
  };
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const providerHint = (process.env.IMAGE_PROVIDER || '').trim().toLowerCase();
  const providers: Array<{ name: string; run: () => Promise<GeneratedImage>; available: boolean }> = [
    {
      name: 'openai',
      run: () => generateImageViaOpenAI(prompt),
      available: Boolean(process.env.OPENAI_API_KEY),
    },
    {
      name: 'anthropic',
      run: () => generateImageViaAnthropic(prompt),
      available: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    {
      name: 'xai',
      run: () => generateImageViaXAI(prompt),
      available: Boolean(process.env.XAI_API_KEY),
    },
  ];

  if (providerHint) {
    const target = providers.find((p) => p.name === providerHint);
    if (!target) {
      throw new Error(`IMAGE_PROVIDER=${providerHint} is unsupported. Use one of: openai, anthropic, xai.`);
    }
    if (!target.available) {
      throw new Error(`IMAGE_PROVIDER=${providerHint} selected, but required API key is not set.`);
    }
    return target.run();
  }

  const available = providers.filter((p) => p.available);
  if (available.length === 0) {
    throw new Error('No image provider key found. Set one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or XAI_API_KEY.');
  }

  const errors: string[] = [];
  for (const provider of available) {
    try {
      return await provider.run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${msg}`);
      console.warn(`[TrelloChannel] ${provider.name} image generation failed:`, msg);
    }
  }

  throw new Error(`Image generation failed for all configured providers. ${errors.join(' | ')}`);
}

/**
 * Generates a PDF buffer from a title and markdown-ish content using pdfkit.
 */
export async function generatePdf(filename: string, content: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Title
    const title = filename.replace(/[-_]/g, ' ').replace(/\.pdf$/i, '');
    doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).font('Helvetica').text(new Date().toDateString(), { align: 'center' });
    doc.moveDown(2);

    // Body — render line by line, treating markdown headings simply
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('# ')) {
        doc.moveDown(0.5).fontSize(16).font('Helvetica-Bold').text(line.slice(2));
        doc.fontSize(11).font('Helvetica');
      } else if (line.startsWith('## ')) {
        doc.moveDown(0.5).fontSize(14).font('Helvetica-Bold').text(line.slice(3));
        doc.fontSize(11).font('Helvetica');
      } else if (line.startsWith('### ')) {
        doc.moveDown(0.3).fontSize(12).font('Helvetica-Bold').text(line.slice(4));
        doc.fontSize(11).font('Helvetica');
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        doc.fontSize(11).font('Helvetica').text(`  • ${line.slice(2)}`);
      } else if (line.trim() === '') {
        doc.moveDown(0.5);
      } else {
        doc.fontSize(11).font('Helvetica').text(line);
      }
    }

    doc.end();
  });
}

/**
 * Creates the trello_attach_pdf tool that the AI agent can call to generate
 * a PDF from markdown/text content and attach it to the current Trello card.
 */
export function createTrelloTools(client: TrelloClient) {
  return {
    name: 'trello_attach_pdf',
    label: 'Attach PDF to Trello Card',
    description:
      'Generates a PDF from the provided text/markdown content and attaches it to the current Trello card. ' +
      'Use this when the user asks you to attach a report, document, or file to the card.',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The Trello card ID to attach the PDF to.',
        },
        filename: {
          type: 'string',
          description: 'The filename for the PDF (without .pdf extension).',
        },
        content: {
          type: 'string',
          description: 'The text content to include in the PDF. Use plain text or markdown.',
        },
      },
      required: ['cardId', 'filename', 'content'],
    },
    async execute(_toolCallId: string, params: { cardId: string; filename: string; content: string }) {
      const { cardId, filename, content } = params;
      try {
        const pdfBuffer = await generatePdf(filename, content);
        const pdfFilename = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
        const attachment = await client.uploadAttachment(cardId, pdfFilename, pdfBuffer, 'application/pdf');
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, filename: pdfFilename, attachmentId: attachment.id, url: attachment.url }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
          isError: true,
        };
      }
    },
  };
}
