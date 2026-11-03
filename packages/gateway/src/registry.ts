import type { ChatProvider, NpcDescriptor, NpcId } from "@glc/shared";

export interface NpcRegistration {
  descriptor: NpcDescriptor;
  provider?: ChatProvider;
}

/** All NPC identities and adapters live here, not in the HTTP endpoints. */
export class NpcRegistry {
  private readonly entries = new Map<NpcId, NpcRegistration>();

  register(registration: NpcRegistration): void {
    const { id } = registration.descriptor;
    if (this.entries.has(id)) throw new Error("Duplicate NPC registration: " + id);
    if (registration.descriptor.capabilities.some(c => c.id === "chat") && !registration.provider) {
      throw new Error("A chat-capable NPC needs a provider: " + id);
    }
    this.entries.set(id, registration);
  }

  get(id: NpcId): NpcRegistration | undefined {
    return this.entries.get(id);
  }

  list(): NpcDescriptor[] {
    return [...this.entries.values()].map(({ descriptor }) => ({
      ...descriptor,
      capabilities: descriptor.capabilities.map(capability => ({ ...capability }))
    }));
  }
}

export function createDefaultNpcRegistry(johnProvider: ChatProvider): NpcRegistry {
  const registry = new NpcRegistry();

  const registrations: NpcRegistration[] = [
    {
      descriptor: {
        id: "john", displayName: "John Stewart", represents: "ChatGPT (mock mode)",
        adapterId: johnProvider.id, status: "ready",
        capabilities: [{ id: "chat", label: "Talk to John", risk: "safe" }]
      },
      provider: johnProvider
    },
    {
      descriptor: {
        id: "hal", displayName: "Hal Jordan", represents: "Gemini",
        adapterId: "gemini", status: "unconfigured", capabilities: []
      }
    },
    {
      descriptor: {
        id: "kyle", displayName: "Kyle Rayner", represents: "Claude",
        adapterId: "anthropic", status: "unconfigured", capabilities: []
      }
    },
    {
      descriptor: {
        id: "guy", displayName: "Guy Gardner", represents: "Fourth AI (TBD)",
        adapterId: "unconfigured", status: "unconfigured", capabilities: []
      }
    },
    {
      descriptor: {
        id: "sinestro", displayName: "Sinestro", represents: "WhatsApp",
        adapterId: "whatsapp", status: "unconfigured", capabilities: []
      }
    },
    {
      descriptor: {
        id: "kilowog", displayName: "Kilowog", represents: "Discord",
        adapterId: "discord", status: "unconfigured", capabilities: []
      }
    }
  ];

  for (const registration of registrations) registry.register(registration);
  return registry;
}
