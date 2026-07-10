import Decimal from "decimal.js";

const ArithmeticDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1_000_000,
  toExpPos: 1_000_000,
});

export interface DecimalBounds {
  maximum: string;
  maximumFractionDigits: number;
}

export const INPUT_DECIMAL_BOUNDS: DecimalBounds = Object.freeze({
  maximum: "1000000000",
  maximumFractionDigits: 6,
});

export class DecimalDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalDomainError";
  }
}

type DecimalOperand = DecimalValue | string;

const decimalPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

const canonicalString = (value: Decimal): string => {
  const fixed = value.toFixed();
  if (fixed === "-0") return "0";
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integerPart = "0", fractionPart] = unsigned.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "");
  const fraction = fractionPart?.replace(/0+$/, "") ?? "";
  const canonical = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return canonical === "0" ? "0" : negative ? `-${canonical}` : canonical;
};

const validateInput = (value: string, bounds?: DecimalBounds): string => {
  const match = decimalPattern.exec(value);
  if (!match) {
    throw new DecimalDomainError("invalid decimal string");
  }

  const fraction = match[3] ?? match[4] ?? "";
  if (bounds && fraction.length > bounds.maximumFractionDigits) {
    throw new DecimalDomainError(
      "decimal fractional precision exceeds configured maximum",
    );
  }

  const parsed = new ArithmeticDecimal(value);
  if (bounds) {
    const maximum = new ArithmeticDecimal(bounds.maximum);
    if (!maximum.isFinite() || maximum.isNegative()) {
      throw new DecimalDomainError("invalid decimal maximum");
    }
    if (parsed.abs().greaterThan(maximum)) {
      throw new DecimalDomainError("decimal exceeds configured maximum");
    }
  }
  return canonicalString(parsed);
};

/**
 * An arbitrary-precision decimal value. Its constructor is private so domain
 * callers can only cross the boundary through a decimal string.
 */
export class DecimalValue {
  private constructor(private readonly value: Decimal) {}

  private static asDecimal(value: DecimalOperand): Decimal {
    return value instanceof DecimalValue
      ? value.value
      : new ArithmeticDecimal(validateInput(value));
  }

  static parse(value: string, bounds?: DecimalBounds): DecimalValue {
    return new DecimalValue(
      new ArithmeticDecimal(validateInput(value, bounds)),
    );
  }

  static zero(): DecimalValue {
    return new DecimalValue(new ArithmeticDecimal(0));
  }

  add(value: DecimalOperand): DecimalValue {
    return new DecimalValue(this.value.plus(DecimalValue.asDecimal(value)));
  }

  subtract(value: DecimalOperand): DecimalValue {
    return new DecimalValue(this.value.minus(DecimalValue.asDecimal(value)));
  }

  multiply(value: DecimalOperand): DecimalValue {
    return new DecimalValue(this.value.times(DecimalValue.asDecimal(value)));
  }

  divide(value: DecimalOperand): DecimalValue {
    const divisor = DecimalValue.asDecimal(value);
    if (divisor.isZero())
      throw new DecimalDomainError("decimal division by zero");
    return new DecimalValue(this.value.dividedBy(divisor));
  }

  compare(value: DecimalOperand): -1 | 0 | 1 {
    const comparison = this.value.comparedTo(DecimalValue.asDecimal(value));
    return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
  }

  equals(value: DecimalOperand): boolean {
    return this.compare(value) === 0;
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  toString(): string {
    return canonicalString(this.value);
  }

  toDisplayString(fractionDigits = 6): string {
    if (!Number.isInteger(fractionDigits) || fractionDigits < 0) {
      throw new DecimalDomainError(
        "display fraction digits must be a non-negative integer",
      );
    }
    return this.value.toFixed(fractionDigits, ArithmeticDecimal.ROUND_HALF_UP);
  }
}

export const canonicalizeDecimal = (value: string, bounds?: DecimalBounds) =>
  DecimalValue.parse(value, bounds).toString();

export const formatDecimal = (value: string, fractionDigits = 6) =>
  DecimalValue.parse(value).toDisplayString(fractionDigits);

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let dividend = left < 0n ? -left : left;
  let divisor = right < 0n ? -right : right;
  while (divisor !== 0n) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
};

const powerOfTen = (exponent: number): bigint => 10n ** BigInt(exponent);

/**
 * An exact fraction for operations, such as split ratios, whose decimal
 * representation may not terminate. It only becomes a decimal string at the
 * domain output boundary.
 */
export class RationalValue {
  private constructor(
    private readonly numerator: bigint,
    private readonly denominator: bigint,
  ) {}

  static zero(): RationalValue {
    return new RationalValue(0n, 1n);
  }

  static fromDecimal(value: string, bounds?: DecimalBounds): RationalValue {
    const canonical = validateInput(value, bounds);
    const negative = canonical.startsWith("-");
    const unsigned = negative ? canonical.slice(1) : canonical;
    const [integerPart, fractionPart = ""] = unsigned.split(".");
    const numerator = BigInt(
      `${negative ? "-" : ""}${integerPart}${fractionPart}`,
    );
    return RationalValue.normalize(numerator, powerOfTen(fractionPart.length));
  }

  static fromRatio(numerator: string, denominator: string): RationalValue {
    if (!/^[1-9]\d*$/.test(numerator) || !/^[1-9]\d*$/.test(denominator)) {
      throw new DecimalDomainError(
        "rational ratio values must be positive integers",
      );
    }
    return RationalValue.normalize(BigInt(numerator), BigInt(denominator));
  }

  add(value: RationalValue): RationalValue {
    return RationalValue.normalize(
      this.numerator * value.denominator + value.numerator * this.denominator,
      this.denominator * value.denominator,
    );
  }

  subtract(value: RationalValue): RationalValue {
    return RationalValue.normalize(
      this.numerator * value.denominator - value.numerator * this.denominator,
      this.denominator * value.denominator,
    );
  }

  multiply(value: RationalValue): RationalValue {
    return RationalValue.normalize(
      this.numerator * value.numerator,
      this.denominator * value.denominator,
    );
  }

  isNegative(): boolean {
    return this.numerator < 0n;
  }

  isPositive(): boolean {
    return this.numerator > 0n;
  }

  toString(): string {
    let remainingDenominator = this.denominator;
    let twos = 0;
    let fives = 0;
    while (remainingDenominator % 2n === 0n) {
      remainingDenominator /= 2n;
      twos += 1;
    }
    while (remainingDenominator % 5n === 0n) {
      remainingDenominator /= 5n;
      fives += 1;
    }

    if (remainingDenominator === 1n) {
      const scale = Math.max(twos, fives);
      if (scale === 0) return this.numerator.toString();
      const scaledNumerator =
        this.numerator *
        2n ** BigInt(scale - twos) *
        5n ** BigInt(scale - fives);
      const negative = scaledNumerator < 0n;
      const digits = (negative ? -scaledNumerator : scaledNumerator)
        .toString()
        .padStart(scale + 1, "0");
      const integer = digits.slice(0, -scale) || "0";
      const fraction =
        scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
      const result = fraction.length > 0 ? `${integer}.${fraction}` : integer;
      return result === "0" ? "0" : negative ? `-${result}` : result;
    }

    return DecimalValue.parse(this.numerator.toString())
      .divide(this.denominator.toString())
      .toString();
  }

  private static normalize(
    numerator: bigint,
    denominator: bigint,
  ): RationalValue {
    if (denominator === 0n)
      throw new DecimalDomainError("rational division by zero");
    const positiveDenominator = denominator < 0n ? -denominator : denominator;
    const signedNumerator = denominator < 0n ? -numerator : numerator;
    if (signedNumerator === 0n) return RationalValue.zero();
    const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator);
    return new RationalValue(
      signedNumerator / divisor,
      positiveDenominator / divisor,
    );
  }
}
