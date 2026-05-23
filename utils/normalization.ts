interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
  lastQuery?: { type: "mentors"; filter?: string; page: number };
  pendingMentor?: {
    name: string;
    organization: string;
    description?: string;
    expertise?: string;
    linkedin?: string;
    instagram?: string;
    github?: string;
    email?: string;
    phoneNoCountryCode: string;
  };
  pendingEdit?: {
    mentorId: number;
    flag: string;
    phoneNoCountryCode: string;
  };
}

export function cleanRole(role: string, email?: string): string {
  let cleaned = (role || "").trim();
  if (email && email.trim()) {
    const trimmedEmail = email.trim();
    if (cleaned.endsWith(trimmedEmail)) {
      cleaned = cleaned.slice(0, -trimmedEmail.length).trim();
    }
  }
  return cleaned
    .replace(/^[-\s]+/, "")
    .replace(/[-\s]+$/, "")
    .trim();
}

export function popUserMessage(session: UserSession, userPrompt: string): void {
  if (
    session.messages.length > 0 &&
    session.messages[session.messages.length - 1].content === userPrompt
  ) {
    session.messages.pop();
  }
}

export function combineCountryCodeAndNumber(
  countryCode: string,
  rawNumber: string,
): string {
  const ccDigits = countryCode.replace(/\D/g, "");
  const numDigits = rawNumber.replace(/\D/g, "");
  return `+${ccDigits} ${numDigits}`;
}

export function formatWithCountryCode(rawPhone: string): {
  formatted?: string;
  needsCountryCode: boolean;
  rawNumber?: string;
} {
  const cleaned = rawPhone.trim();
  if (!cleaned) return { needsCountryCode: false };
  const startsWithPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");
  if (startsWithPlus) {
    if (digits.startsWith("1")) {
      return {
        formatted: `+1 ${digits.substring(1)}`,
        needsCountryCode: false,
      };
    }
    if (digits.startsWith("7")) {
      return {
        formatted: `+7 ${digits.substring(1)}`,
        needsCountryCode: false,
      };
    }
    const threeDigitCountryCodes = [
      "971", "966", "965", "968", "973", "974", "353", "370", "371", "372", "380", "506", "507", "509"
    ];
    const prefix3 = digits.substring(0, 3);
    if (threeDigitCountryCodes.includes(prefix3)) {
      return {
        formatted: `+${prefix3} ${digits.substring(3)}`,
        needsCountryCode: false,
      };
    }
    const prefix2 = digits.substring(0, 2);
    return {
      formatted: `+${prefix2} ${digits.substring(2)}`,
      needsCountryCode: false,
    };
  }
  if (digits.length <= 10) {
    return { needsCountryCode: true, rawNumber: digits };
  }
  if (digits.startsWith("91") && digits.length === 12) {
    return { formatted: `+91 ${digits.substring(2)}`, needsCountryCode: false };
  }
  if (digits.startsWith("971") && digits.length === 12) {
    return {
      formatted: `+971 ${digits.substring(3)}`,
      needsCountryCode: false,
    };
  }
  return { needsCountryCode: true, rawNumber: digits };
}
