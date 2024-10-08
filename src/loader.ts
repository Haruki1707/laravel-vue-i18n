import fs, { existsSync, readdirSync } from 'fs'
import path from 'path'
import { Engine } from 'php-parser'
import { ParsedLangFileInterface } from './interfaces/parsed-lang-file'

export const hasPhpTranslations = (folderPath: string): boolean => {
  folderPath = folderPath.replace(/[\\/]$/, '') + path.sep

  try {
    const folders = fs
      .readdirSync(folderPath)
      .filter((file) => fs.statSync(folderPath + path.sep + file).isDirectory())
      .sort()

    for (const folder of folders) {
      const lang = {}

      const files = fs.readdirSync(folderPath + path.sep + folder).filter((file) => /\.php$/.test(file))

      if (files.length > 0) {
        return true
      }
    }
  } catch (e) {}

  return false
}

export const parseAll = (folderPath: string): ParsedLangFileInterface[] => {
  folderPath = folderPath.replace(/[\\/]$/, '') + path.sep

  if (!fs.existsSync(folderPath)) {
    return []
  }

  const folders = fs
    .readdirSync(folderPath)
    .filter((file) => fs.statSync(folderPath + path.sep + file).isDirectory())
    .sort()

  const data = []
  for (const folder of folders) {
    const langFolderPath = folderPath + path.sep + folder

    const lang = readThroughDir(langFolderPath)

    data.push({
      folder,
      translations: convertToDotsSyntax(lang)
    })
  }

  // If data contains an object with folder name 'vendor'
  const vendorIndex = data.findIndex(({ folder }) => folder === 'vendor');

  if (vendorIndex !== -1) {
    const vendorTranslations = data[vendorIndex].translations;
    data.splice(vendorIndex, 1);

    data.forEach(langFile =>
      langFile.translations = mergeVendorTranslations(langFile.folder, langFile.translations, vendorTranslations));
  }

  return data
    .filter(({ translations }) => {
      return Object.keys(translations).length > 0
    })
    .map(({ folder, translations }) => {
      return {
        name: `php_${folder}.json`,
        translations
      }
    })
}

function mergeVendorTranslations(folder: string, translations: any, vendorTranslations: any) {
  // Filter the translations from the vendor file that match the current folder
  const langTranslationsFromVendor = Object
    .entries(vendorTranslations)
    .filter(([key]) => key.includes(`.${folder}.`))
    .reduce((acc, [key, value]) => ({
      ...acc,
      [key.replace(`.${folder}.`, '::')]: value,
    }), {});

  // Merge the vendor translations that matched the folder with the current translations
  return { ...translations, ...langTranslationsFromVendor };
}

export const parsePackage = (langPath: string, packageName: string) => {
  return parseAll(langPath).map(langFile => {
    const reducedTranslations = Object.entries(langFile.translations)
      .reduce((acc, [key, value]) => ({...acc, [`${packageName}::${key}`]: value}), {});
    return {...langFile, translations: reducedTranslations};
  });
}

export const parse = (content: string) => {
  const arr = new Engine({}).parseCode(content, 'lang').children.filter((child) => child.kind === 'return')[0] as any

  if (arr?.expr?.kind !== 'array') {
    return {}
  }

  return convertToDotsSyntax(parseItem(arr.expr))
}

const parseItem = (expr) => {
  if (expr.kind === 'string') {
    return expr.value
  }

  if (expr.kind === 'nullkeyword') {
    return null
  }

  if (expr.kind === 'array') {
    let items = expr.items.map((item) => parseItem(item))

    if (expr.items.every((item) => item.key !== null)) {
      items = items.reduce((acc, val) => Object.assign({}, acc, val), {})
    }

    return items
  }

  if (expr.kind === 'bin') {
    return parseItem(expr.left) + parseItem(expr.right)
  }

  if (expr.key) {
    return { [expr.key.value]: parseItem(expr.value) }
  }

  return parseItem(expr.value)
}

const convertToDotsSyntax = (list) => {
  const flatten = (items, context = '') => {
    const data = {}

    if (items === null) {
      return data
    }

    Object.entries(items).forEach(([key, value]) => {
      if (typeof value === 'string') {
        data[context + key] = value
        return
      }

      Object.entries(flatten(value, context + key + '.')).forEach(([itemKey, itemValue]) => {
        data[itemKey] = itemValue
      })
    })

    return data
  }

  return flatten(list)
}

export const reset = (folderPath) => {
  const dir = fs.readdirSync(folderPath)

  dir
    .filter((file) => file.match(/^php_/))
    .forEach((file) => {
      fs.unlinkSync(folderPath + file)
    })
}

export const readThroughDir = (dir) => {
  const data = {}

  fs.readdirSync(dir).forEach((file) => {
    const absoluteFile = dir + path.sep + file

    if (fs.statSync(absoluteFile).isDirectory()) {
      const subFolderFileKey = file.replace(/\.\w+$/, '')

      data[subFolderFileKey] = readThroughDir(absoluteFile)
    } else {
      data[file.replace(/\.\w+$/, '')] = parse(fs.readFileSync(absoluteFile).toString())
    }
  })

  return data
}

export const prepareExtendedParsedLangFiles = (langPaths: string[], packages?: Package[]): ParsedLangFileInterface[] =>
  [
    ...(packages || []).flatMap(pkg => parsePackage(pkg.langPath, pkg.name)),
    ...langPaths.flatMap(langPath => parseAll(langPath)),
  ];

export const generateFiles = (langPath: string, data: ParsedLangFileInterface[]): ParsedLangFileInterface[] => {
  data = mergeData(data)

  if (!fs.existsSync(langPath)) {
    fs.mkdirSync(langPath)
  }

  data.forEach(({ name, translations }) => {
    fs.writeFileSync(langPath + name, JSON.stringify(translations))
  })

  return data
}

export const getPackagesLangPaths = (vendorFolder = 'vendor'): Package[] => {
  const vendors = readdirSync(vendorFolder, {withFileTypes: true}).filter(dir => dir.isDirectory());

  return vendors.flatMap(vendor => {
    const packages = readdirSync(`${vendorFolder}/${vendor.name}`, {withFileTypes: true}).filter(dir => dir.isDirectory());

    return packages.map(pkg => {
      const pkgPath = `${vendorFolder}/${vendor.name}/${pkg.name}`;

      if (existsSync(`${pkgPath}/resources/lang`)) {
        return {name: pkg.name, langPath: `${pkgPath}/resources/lang`};
      } else if (existsSync(`${pkgPath}/lang`)) {
        return {name: pkg.name, langPath: `${pkgPath}/lang`};
      }

      return null;
    }).filter(Boolean);
  });
};

function mergeData(data: ParsedLangFileInterface[]): ParsedLangFileInterface[] {
  const obj = {}

  data.forEach(({ name, translations }) => {
    if (!obj[name]) {
      obj[name] = {}
    }

    obj[name] = { ...obj[name], ...translations }
  })

  const arr = []
  Object.entries(obj).forEach(([name, translations]) => {
    arr.push({ name, translations })
  })

  return arr
}
