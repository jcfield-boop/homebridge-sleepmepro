#!/usr/bin/env node
try {
    require('@typescript-eslint/parser');
    console.log('@typescript-eslint/parser found');
  } catch (error) {
    console.error('@typescript-eslint/parser not found:', error.message);
  }
  
  try {
    require('@typescript-eslint/eslint-plugin');
    console.log('@typescript-eslint/eslint-plugin found');
  } catch (error) {
    console.error('@typescript-eslint/eslint-plugin not found:', error.message);
  }