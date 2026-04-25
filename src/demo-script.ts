type DemoWorkflowOperation = Record<string, unknown>;

interface DemoScriptEntry {
  id: string;
  description: string;
  patterns: RegExp[];
  operations: DemoWorkflowOperation[];
}

interface DemoScriptMatch {
  id: string;
  description: string;
  operations: DemoWorkflowOperation[];
}

const demoScriptEntries: DemoScriptEntry[] = [
  {
    id: 'flight-star-alliance-austin',
    description: 'Star Alliance flight search results for Austin travel cards',
    patterns: [
      /book flights? for the customer meeting in austin/i,
      /star alliance/i,
      /flights?.*austin/i,
    ],
    operations: [
      {
        op: 'add_comment',
        commentText:
          'I am searching booking options now using your calendar timing and previous flight preferences.\n\n' +
          '**Current Star Alliance options for Austin (AUS):**\n\n' +
          '1. **United UA2417**\n' +
          '   - Route: SEA -> AUS\n' +
          '   - Time: Thu 08:40-14:32\n' +
          '   - Fare: Economy Flex\n' +
          '   - Price: **$412**\n\n' +
          '2. **Air Canada AC542 + UA1323**\n' +
          '   - Route: YVR -> AUS\n' +
          '   - Time: Thu 09:20-15:41\n' +
          '   - Fare: Economy Standard\n' +
          '   - Price: **$438**\n\n' +
          '3. **Lufthansa LH7621 + UA1198**\n' +
          '   - Route: SFO -> AUS\n' +
          '   - Time: Thu 07:55-13:18\n' +
          '   - Fare: Premium Economy\n' +
          '   - Price: **$689**\n\n' +
          'I attached direct booking links for each option below.\n\n' +
          'Reply with **"confirm option #"** and I will continue.'
      },
      {
        op: 'attach_link',
        url: 'https://www.united.com/en/us/fsr/choose-flights?f=SEA&t=AUS',
        filename: 'United booking option 1'
      },
      {
        op: 'attach_link',
        url: 'https://www.aircanada.com/us/en/aco/home/book/flights.html',
        filename: 'Air Canada booking option 2'
      },
      {
        op: 'attach_link',
        url: 'https://www.lufthansa.com/us/en/booking',
        filename: 'Lufthansa booking option 3'
      },
      {
        op: 'add_creator_member'
      }
    ],
  },
  {
    id: 'concur-expenses-las-vegas',
    description: 'Concur expense workflow for tradeshow cards',
    patterns: [
      /las vegas tradeshow expenses/i,
      /concur/i,
      /expense(s)? report/i,
    ],
    operations: [
      {
        op: 'add_comment',
        commentText:
          'I am scanning your emails during your travel dates to collect receipt attachments and confirmation emails for this trip.'
      },
      {
        op: 'add_checklist_item',
        checklistName: 'Expense Workflow',
        checklistItemName: 'Create an expense report if one does not already exist'
      },
      {
        op: 'add_checklist_item',
        checklistName: 'Expense Workflow',
        checklistItemName: 'Upload receipts to the expense report'
      },
      {
        op: 'attach_link',
        url: 'https://www.concur.com/',
        filename: 'Concur'
      },
      {
        op: 'complete_checklist_item',
        checklistName: 'Expense Workflow',
        checklistItemName: 'Create an expense report if one does not already exist'
      },
      {
        op: 'complete_checklist_item',
        checklistName: 'Expense Workflow',
        checklistItemName: 'Upload receipts to the expense report'
      },
      {
        op: 'mark_complete'
      }
    ],
  },
  {
    id: 'product-launch-announcement',
    description: 'Launch announcement package',
    patterns: [
      /announce the new trelloclaw product launch/i,
      /product launch/i,
    ],
    operations: [
      {
        op: 'add_checklist_item',
        checklistName: 'Launch Workflow',
        checklistItemName: 'Drafting message'
      },
      {
        op: 'update_description',
        cardDesc: 'Meet TrelloClaw: the fastest way to turn board tasks into finished work with AI automation. Launching now. #TrelloClaw #ProductLaunch'
      },
      {
        op: 'complete_checklist_item',
        checklistName: 'Launch Workflow',
        checklistItemName: 'Drafting message'
      },
      {
        op: 'add_checklist_item',
        checklistName: 'Launch Workflow',
        checklistItemName: 'Finding appropriate gif'
      },
      {
        op: 'complete_checklist_item',
        checklistName: 'Launch Workflow',
        checklistItemName: 'Finding appropriate gif'
      },
      {
        op: 'add_checklist_item',
        checklistName: 'Launch Workflow',
        checklistItemName: 'Uploading gif'
      },
      {
        op: 'attach_remote_file',
        url: 'https://media.tenor.com/NvmqvFu5FPIAAAAC/agile-rocket.gif',
        filename: 'trelloclaw-plugin-launch.gif',
        mimeType: 'image/gif'
      },
      {
        op: 'complete_checklist_item',
        checklistName: 'Launch Workflow',
        checklistItemName: 'Uploading gif'
      },
      {
        op: 'add_comment',
        commentText: 'Done. Added a tweet-length launch draft to the description and uploaded an animated GIF.'
      }
    ],
  },
  {
    id: 'customer-pricing-response',
    description: 'Customer pricing follow-up',
    patterns: [
      /respond to the customer with the latest pricing page/i,
      /latest pricing page/i,
    ],
    operations: [
      {
        op: 'update_description',
        cardDesc:
          'Subject: Latest pricing for Northstar Home Supply\n\n' +
          'Hi Maya Patel,\n\n' +
          'Thanks for following up. Here is our latest pricing page with current plans and limits:\n' +
          'https://harborlightsoftware.com/pricing\n\n' +
          'If you share your expected usage, I can recommend the best-fit plan for Northstar Home Supply.\n\n' +
          'Best,\n' +
          'Jordan Lee\n' +
          'Harborlight Software'
      },
      {
        op: 'mark_complete'
      }
    ],
  },
  {
    id: 'dinner-booking-romantic-italian',
    description: 'Dinner reservation options',
    patterns: [
      /book dinner at a romantic italian restaurant/i,
      /romantic italian restaurant/i,
      /book dinner/i,
    ],
    operations: [
      {
        op: 'attach_link',
        url: 'https://www.opentable.com/s/?dateTime=2026-04-24T19%3A00%3A00&covers=2&metroId=4&term=terun%20palo%20alto',
        filename: 'OpenTable booking options (Terun)'
      },
      {
        op: 'attach_link',
        url: 'https://www.google.com/maps/dir/?api=1&destination=Terun%20Palo%20Alto',
        filename: 'Directions to Terun (Palo Alto)'
      },
      {
        op: 'attach_remote_file',
        url: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1400&q=80',
        filename: 'romantic-restaurant-cover.jpg',
        mimeType: 'image/jpeg',
        setAsCover: true
      },
      {
        op: 'add_creator_member'
      },
      {
        op: 'add_comment',
        commentText: 'I added OpenTable and maps links for Terun in Palo Alto, set a restaurant cover image, and assigned you. Please confirm booking for 7:00 PM.'
      }
    ],
  },
  {
    id: 'dinner-booking-confirmation',
    description: 'Dinner booking confirmation and completion',
    patterns: [
      /confirm(?:ed|ing)?\s+(?:the\s+)?booking/i,
      /approve(?:d)?\s+.*7(?::00)?\s*pm/i,
      /book\s+it\s+for\s+7(?::00)?\s*pm/i,
      /7(?::00)?\s*pm\s+(?:sounds?\s+good|is\s+great)/i,
      /(?:sounds?\s+good|is\s+great).*7(?::00)?\s*pm/i,
      /7(?::00)?\s*pm\s+works/i,
      /works?.*7(?::00)?\s*pm/i,
    ],
    operations: [
      {
        op: 'add_comment',
        commentText: 'Done. Booking confirmed for 7:00 PM.'
      },
      {
        op: 'mark_complete'
      }
    ],
  },
];

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function matchDemoScriptPrompt(text: string): DemoScriptMatch | undefined {
  const normalized = String(text || '').trim();
  if (!normalized) return undefined;

  for (const entry of demoScriptEntries) {
    if (matchesAnyPattern(normalized, entry.patterns)) {
      return {
        id: entry.id,
        description: entry.description,
        operations: entry.operations,
      };
    }
  }
  return undefined;
}

export function buildDemoScriptWorkflowResponse(match: DemoScriptMatch): string {
  return JSON.stringify({
    type: 'workflow',
    operations: match.operations,
  });
}
