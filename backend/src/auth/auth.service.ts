import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { LoginDto } from './dto/login.dto';

type OwnerRecord = {
  email: string;
  password: string;
  storeId: string;
  name: string;
};

@Injectable()
export class AuthService {
  constructor(private readonly configService: ConfigService) {}

  private readonly owners: OwnerRecord[] = [
    { email: 'owner1@amboras.dev', password: 'amboras-store-001', storeId: 'store_001', name: 'Ava Martin' },
    { email: 'owner2@amboras.dev', password: 'amboras-store-002', storeId: 'store_002', name: 'Noah Patel' },
    { email: 'owner3@amboras.dev', password: 'amboras-store-003', storeId: 'store_003', name: 'Mia Chen' },
  ];

  login(input: LoginDto) {
    const owner = this.owners.find((item) => item.email === input.email && item.password === input.password);

    if (!owner) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new UnauthorizedException('Server is missing JWT_SECRET');
    }

    const accessToken = jwt.sign(
      {
        sub: owner.email,
        store_id: owner.storeId,
        role: 'store_owner',
      },
      secret,
      { expiresIn: '12h' },
    );

    return {
      accessToken,
      owner: {
        email: owner.email,
        name: owner.name,
        storeId: owner.storeId,
      },
    };
  }

  listDemoOwners() {
    return this.owners.map(({ password, ...owner }) => owner);
  }
}
